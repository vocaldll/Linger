import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	Account,
	AccountConfiguration,
	AccountStatus,
	AutoStopTarget,
	CardFarmingEntry,
	CardFarmingPolicy,
	NewAccount,
	RuntimePatch,
} from "./domain/account.js";
import {
	hasNormalPresence,
	validateAccountSetup,
	validateAutoStopTargets,
	validateCardFarmingExclusions,
	validateCardFarmingQueue,
} from "./domain/account.js";
import type { OwnedGame } from "./domain/game-library.js";
import type {
	RuntimeSnapshot,
	StoredRuntimeSnapshot,
} from "./domain/runtime-snapshot.js";
import { parseRuntimeSnapshot } from "./domain/runtime-snapshot.js";

type AccountRow = {
	id: string;
	account_name: string;
	steam_id: string | null;
	refresh_token_encrypted: string;
	machine_auth_token_encrypted: string | null;
	app_ids_json: string;
	auto_stop_targets_json: string;
	custom_game: string | null;
	away_message: string | null;
	visible: number;
	clear_recent_activity: number;
	card_farming_enabled: number;
	card_farming_queue_json: string;
	card_farming_exclusions_json: string;
	card_farming_policy: CardFarmingPolicy;
	card_farming_rescan: number;
	auto_restart: number;
	enabled: number;
	revision: number;
	restart_nonce: number;
	status: AccountStatus;
	last_error: string | null;
	last_connected_at: string | null;
	created_at: string;
	updated_at: string;
};

type OwnedGameRow = {
	app_id: number;
	name: string;
	playtime_forever: number;
};

type TrackedPlaytimeRow = {
	app_id: number;
	playtime_forever: number;
};

export type LibraryRefreshState = {
	requestedNonce: number;
	completedNonce: number;
	lastError: string | null;
	requestedAt: string | null;
	lastAttemptAt: string | null;
	lastSuccessAt: string | null;
};

export type CardFarmingScanState = {
	requestedNonce: number;
	completedNonce: number;
	lastError: string | null;
	results: CardFarmingEntry[];
	requestedAt: string | null;
	lastAttemptAt: string | null;
	lastSuccessAt: string | null;
};

type CardFarmingScanRow = {
	requested_nonce: number;
	completed_nonce: number;
	last_error: string | null;
	results_json: string;
	requested_at: string | null;
	last_attempt_at: string | null;
	last_success_at: string | null;
};

type LibraryRefreshRow = {
	requested_nonce: number;
	completed_nonce: number;
	last_error: string | null;
	requested_at: string | null;
	last_attempt_at: string | null;
	last_success_at: string | null;
};

type RuntimeSnapshotRow = {
	account_id: string;
	runner_owner_id: string;
	snapshot_json: string;
	recorded_at: string;
};

export type RunnerLease = {
	ownerId: string;
	heartbeatAt: string;
};

const ACCOUNT_COLUMNS = `
  id, account_name, steam_id, refresh_token_encrypted, machine_auth_token_encrypted,
  app_ids_json, auto_stop_targets_json, custom_game, away_message, visible, clear_recent_activity, card_farming_enabled,
  card_farming_queue_json, card_farming_exclusions_json, card_farming_policy, card_farming_rescan,
  auto_restart, enabled, revision, restart_nonce, status,
  last_error, last_connected_at, created_at, updated_at
`;

function parseAppIdsJson(value: string): number[] {
	const parsed: unknown = JSON.parse(value);
	if (
		!Array.isArray(parsed) ||
		!parsed.every((item) => Number.isSafeInteger(item) && item > 0)
	) {
		throw new Error("Stored account has invalid AppIDs");
	}
	return parsed as number[];
}

function parseCardFarmingQueueJson(value: string): CardFarmingEntry[] {
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed)) {
		throw new Error("Stored account has an invalid card-farming queue");
	}
	const queue = parsed as CardFarmingEntry[];
	validateCardFarmingQueue(queue);
	return queue;
}

function parseCardFarmingExclusionsJson(value: string): number[] {
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed)) {
		throw new Error("Stored account has invalid card-farming exclusions");
	}
	const exclusions = parsed as number[];
	validateCardFarmingExclusions(exclusions);
	return exclusions;
}

function parseAutoStopTargetsJson(
	value: string,
	appIds: readonly number[],
): AutoStopTarget[] {
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed)) {
		throw new Error("Stored account has invalid auto-stop targets");
	}
	const targets = parsed as AutoStopTarget[];
	validateAutoStopTargets(targets, appIds);
	return targets;
}

function mapAccount(row: AccountRow): Account {
	const appIds = parseAppIdsJson(row.app_ids_json);
	return {
		id: row.id,
		accountName: row.account_name,
		steamId: row.steam_id,
		refreshTokenEncrypted: row.refresh_token_encrypted,
		machineAuthTokenEncrypted: row.machine_auth_token_encrypted,
		appIds,
		autoStopTargets: parseAutoStopTargetsJson(
			row.auto_stop_targets_json,
			appIds,
		),
		customGame: row.custom_game,
		awayMessage: row.away_message,
		visible: row.visible === 1,
		clearRecentActivity: row.clear_recent_activity === 1,
		cardFarmingEnabled: row.card_farming_enabled === 1,
		cardFarmingQueue: parseCardFarmingQueueJson(row.card_farming_queue_json),
		cardFarmingExclusions: parseCardFarmingExclusionsJson(
			row.card_farming_exclusions_json,
		),
		cardFarmingPolicy: row.card_farming_policy,
		cardFarmingRescan: row.card_farming_rescan === 1,
		autoRestart: row.auto_restart === 1,
		enabled: row.enabled === 1,
		revision: row.revision,
		restartNonce: row.restart_nonce,
		status: row.status,
		lastError: row.last_error,
		lastConnectedAt: row.last_connected_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class AccountStore {
	readonly #db: DatabaseSync;

	constructor(databasePath: string) {
		mkdirSync(path.dirname(databasePath), { recursive: true });
		this.#db = new DatabaseSync(databasePath);
		this.#db.exec(
			"PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;",
		);
		this.#migrate();
	}

	close(): void {
		this.#db.close();
	}

	list(): Account[] {
		const rows = this.#db
			.prepare(
				`SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY account_name COLLATE NOCASE`,
			)
			.all() as AccountRow[];
		return rows.map(mapAccount);
	}

	get(id: string): Account | null {
		const row = this.#db
			.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`)
			.get(id) as AccountRow | undefined;
		return row ? mapAccount(row) : null;
	}

	getByName(accountName: string): Account | null {
		const row = this.#db
			.prepare(
				`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE account_name = ? COLLATE NOCASE`,
			)
			.get(accountName) as AccountRow | undefined;
		return row ? mapAccount(row) : null;
	}

	create(input: NewAccount): Account {
		validateAccountSetup(input);
		const id = randomUUID();
		const now = new Date().toISOString();
		this.#db
			.prepare(`
        INSERT INTO accounts (
          id, account_name, steam_id, refresh_token_encrypted, machine_auth_token_encrypted,
          app_ids_json, auto_stop_targets_json, custom_game, visible, clear_recent_activity, card_farming_enabled,
          card_farming_queue_json, card_farming_exclusions_json, card_farming_policy, card_farming_rescan,
          auto_restart, enabled, revision, restart_nonce, status,
          last_error, last_connected_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', 'manual', 0, ?, ?, 1, 0, ?, NULL, NULL, ?, ?)
      `)
			.run(
				id,
				input.accountName,
				input.steamId,
				input.refreshTokenEncrypted,
				input.machineAuthTokenEncrypted,
				JSON.stringify(input.appIds),
				JSON.stringify(input.autoStopTargets),
				input.customGame?.trim() || null,
				input.visible ? 1 : 0,
				input.clearRecentActivity ? 1 : 0,
				input.cardFarmingEnabled ? 1 : 0,
				input.autoRestart !== false ? 1 : 0,
				input.enabled ? 1 : 0,
				input.enabled ? "idle" : "disabled",
				now,
				now,
			);
		return this.#require(id);
	}

	updateConfiguration(
		id: string,
		configuration: AccountConfiguration,
	): Account {
		const current = this.#require(id);
		validateAccountSetup({
			...configuration,
			cardFarmingEnabled: current.cardFarmingEnabled,
		});
		const result = this.#db
			.prepare(`
        UPDATE accounts
        SET app_ids_json = ?, auto_stop_targets_json = ?, custom_game = ?, visible = ?, clear_recent_activity = ?,
            revision = revision + 1, updated_at = ?
        WHERE id = ?
      `)
			.run(
				JSON.stringify(configuration.appIds),
				JSON.stringify(configuration.autoStopTargets),
				configuration.customGame?.trim() || null,
				configuration.visible ? 1 : 0,
				configuration.clearRecentActivity ? 1 : 0,
				new Date().toISOString(),
				id,
			);
		this.#assertChanged(result.changes, id);
		return this.#require(id);
	}

	completeAutoStop(id: string, appId: number): Account {
		const account = this.#require(id);
		const target = account.autoStopTargets.find(
			(candidate) => candidate.appId === appId,
		);
		if (!target) {
			return account;
		}
		const appIds = account.appIds.filter((candidate) => candidate !== appId);
		const autoStopTargets = account.autoStopTargets.filter(
			(candidate) => candidate.appId !== appId,
		);
		const keepEnabled =
			account.enabled &&
			(account.cardFarmingEnabled ||
				appIds.length > 0 ||
				Boolean(account.customGame?.trim()));
		const result = this.#db
			.prepare(`
        UPDATE accounts
        SET app_ids_json = ?, auto_stop_targets_json = ?, enabled = ?, status = ?, last_error = NULL,
            revision = revision + 1, updated_at = ?
        WHERE id = ?
      `)
			.run(
				JSON.stringify(appIds),
				JSON.stringify(autoStopTargets),
				keepEnabled ? 1 : 0,
				keepEnabled
					? account.status === "online"
						? "online"
						: "idle"
					: "disabled",
				new Date().toISOString(),
				id,
			);
		this.#assertChanged(result.changes, id);
		return this.#require(id);
	}

	setAwayMessage(id: string, message: string | null): Account {
		const result = this.#db
			.prepare(`
        UPDATE accounts
        SET away_message = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `)
			.run(message?.trim() || null, new Date().toISOString(), id);
		this.#assertChanged(result.changes, id);
		return this.#require(id);
	}

	setAutoRestart(id: string, enabled: boolean): Account {
		const result = this.#db
			.prepare(`
        UPDATE accounts
        SET auto_restart = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `)
			.run(enabled ? 1 : 0, new Date().toISOString(), id);
		this.#assertChanged(result.changes, id);
		return this.#require(id);
	}

	setEnabled(id: string, enabled: boolean): Account {
		const account = this.#require(id);
		if (enabled) {
			validateAccountSetup(account);
		}
		const result = this.#db
			.prepare(`
        UPDATE accounts
        SET enabled = ?, status = ?, last_error = NULL, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `)
			.run(
				enabled ? 1 : 0,
				enabled ? "idle" : "disabled",
				new Date().toISOString(),
				id,
			);
		this.#assertChanged(result.changes, id);
		return this.#require(id);
	}

	setCardFarmingEnabled(id: string, enabled: boolean): Account {
		const account = this.#require(id);
		const keepEnabled =
			enabled || (account.enabled && hasNormalPresence(account));
		const result = this.#db
			.prepare(`
        UPDATE accounts
        SET card_farming_enabled = ?, card_farming_queue_json = '[]',
            enabled = ?, status = ?, last_error = NULL,
            revision = revision + 1, updated_at = ?
        WHERE id = ?
      `)
			.run(
				enabled ? 1 : 0,
				keepEnabled ? 1 : 0,
				keepEnabled
					? account.enabled && account.status === "online"
						? "online"
						: "idle"
					: "disabled",
				new Date().toISOString(),
				id,
			);
		this.#assertChanged(result.changes, id);
		return this.#require(id);
	}

	startCardFarming(
		id: string,
		queue: readonly CardFarmingEntry[],
		exclusions: readonly number[],
		policy: CardFarmingPolicy,
		rescan: boolean,
	): Account {
		if (queue.length === 0) {
			throw new Error("Select at least one farmable game");
		}
		validateCardFarmingQueue(queue);
		validateCardFarmingExclusions(exclusions);
		const queuedAppIds = new Set(queue.map((entry) => entry.appId));
		const overlappingAppId = exclusions.find((appId) =>
			queuedAppIds.has(appId),
		);
		if (overlappingAppId !== undefined) {
			throw new Error(
				`Card-farming AppID ${overlappingAppId} cannot be both queued and excluded`,
			);
		}
		const result = this.#db
			.prepare(`
				UPDATE accounts
				SET card_farming_enabled = 1, card_farming_queue_json = ?,
				    card_farming_exclusions_json = ?, card_farming_policy = ?, card_farming_rescan = ?,
				    enabled = 1, status = CASE WHEN status = 'online' THEN 'online' ELSE 'idle' END,
				    last_error = NULL, revision = revision + 1, updated_at = ?
				WHERE id = ?
			`)
			.run(
				JSON.stringify(queue),
				JSON.stringify(exclusions),
				policy,
				rescan ? 1 : 0,
				new Date().toISOString(),
				id,
			);
		this.#assertChanged(result.changes, id);
		return this.#require(id);
	}

	replaceCardFarmingQueue(
		id: string,
		queue: readonly CardFarmingEntry[],
	): Account {
		validateCardFarmingQueue(queue);
		const result = this.#db
			.prepare(
				"UPDATE accounts SET card_farming_queue_json = ?, updated_at = ? WHERE id = ?",
			)
			.run(JSON.stringify(queue), new Date().toISOString(), id);
		this.#assertChanged(result.changes, id);
		return this.#require(id);
	}

	finishCardFarming(id: string): Account {
		return this.setCardFarmingEnabled(id, false);
	}

	requestRestart(id: string): Account {
		const result = this.#db
			.prepare(
				"UPDATE accounts SET restart_nonce = restart_nonce + 1, revision = revision + 1, updated_at = ? WHERE id = ?",
			)
			.run(new Date().toISOString(), id);
		this.#assertChanged(result.changes, id);
		return this.#require(id);
	}

	replaceCredentials(
		id: string,
		credentials: Pick<
			Account,
			| "accountName"
			| "steamId"
			| "refreshTokenEncrypted"
			| "machineAuthTokenEncrypted"
		>,
	): Account {
		const result = this.#db
			.prepare(`
        UPDATE accounts SET
          account_name = ?, steam_id = ?, refresh_token_encrypted = ?, machine_auth_token_encrypted = ?,
          status = ?, last_error = NULL, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `)
			.run(
				credentials.accountName,
				credentials.steamId,
				credentials.refreshTokenEncrypted,
				credentials.machineAuthTokenEncrypted,
				"idle",
				new Date().toISOString(),
				id,
			);
		this.#assertChanged(result.changes, id);
		return this.#require(id);
	}

	updateRuntime(id: string, patch: RuntimePatch): Account {
		const entries = Object.entries({
			steam_id: patch.steamId,
			status: patch.status,
			last_error: patch.lastError,
			last_connected_at: patch.lastConnectedAt,
			refresh_token_encrypted: patch.refreshTokenEncrypted,
			machine_auth_token_encrypted: patch.machineAuthTokenEncrypted,
		}).filter((entry) => entry[1] !== undefined);
		if (entries.length === 0) {
			return this.#require(id);
		}

		const assignments = entries.map(([column]) => `${column} = ?`).join(", ");
		const values = entries.map(([, value]) => value as string | null);
		const result = this.#db
			.prepare(
				`UPDATE accounts SET ${assignments}, updated_at = ? WHERE id = ?`,
			)
			.run(...values, new Date().toISOString(), id);
		this.#assertChanged(result.changes, id);
		return this.#require(id);
	}

	listOwnedGames(accountId: string): OwnedGame[] {
		const rows = this.#db
			.prepare(`
        SELECT app_id, name, playtime_forever
        FROM owned_games
        WHERE account_id = ?
      `)
			.all(accountId) as OwnedGameRow[];
		return rows.map((row) => ({
			appId: row.app_id,
			name: row.name,
			playtimeForever: row.playtime_forever,
		}));
	}

	replaceOwnedGames(accountId: string, games: readonly OwnedGame[]): void {
		if (!this.get(accountId)) {
			throw new Error(`Account not found: ${accountId}`);
		}
		const normalized = new Map<number, OwnedGame>();
		for (const game of games) {
			const name = game.name.trim();
			if (
				Number.isSafeInteger(game.appId) &&
				game.appId > 0 &&
				name &&
				Number.isSafeInteger(game.playtimeForever) &&
				game.playtimeForever >= 0
			) {
				normalized.set(game.appId, { ...game, name });
			}
		}

		this.#db.exec("BEGIN IMMEDIATE");
		try {
			this.#db
				.prepare("DELETE FROM owned_games WHERE account_id = ?")
				.run(accountId);
			const insert = this.#db.prepare(`
        INSERT INTO owned_games (account_id, app_id, name, playtime_forever)
        VALUES (?, ?, ?, ?)
      `);
			for (const game of normalized.values()) {
				insert.run(accountId, game.appId, game.name, game.playtimeForever);
			}
			this.#db.exec("COMMIT");
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	listTrackedPlaytimes(accountId: string): Map<number, number> {
		const rows = this.#db
			.prepare(`
        SELECT app_id, playtime_forever
        FROM tracked_playtimes
        WHERE account_id = ?
      `)
			.all(accountId) as TrackedPlaytimeRow[];
		return new Map(rows.map((row) => [row.app_id, row.playtime_forever]));
	}

	replaceTrackedPlaytimes(
		accountId: string,
		playtimes: ReadonlyMap<number, number>,
	): void {
		if (!this.get(accountId)) {
			throw new Error(`Account not found: ${accountId}`);
		}
		const normalized = [...playtimes].filter(
			([appId, playtime]) =>
				Number.isSafeInteger(appId) &&
				appId > 0 &&
				Number.isSafeInteger(playtime) &&
				playtime >= 0,
		);

		this.#db.exec("BEGIN IMMEDIATE");
		try {
			this.#db
				.prepare("DELETE FROM tracked_playtimes WHERE account_id = ?")
				.run(accountId);
			const insert = this.#db.prepare(`
        INSERT INTO tracked_playtimes (account_id, app_id, playtime_forever)
        VALUES (?, ?, ?)
      `);
			for (const [appId, playtime] of normalized) {
				insert.run(accountId, appId, playtime);
			}
			this.#db.exec("COMMIT");
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	requestLibraryRefresh(accountId: string): number {
		if (!this.get(accountId)) {
			throw new Error(`Account not found: ${accountId}`);
		}
		const requestedAt = new Date().toISOString();
		this.#db
			.prepare(`
        INSERT INTO library_refresh_requests (
          account_id, requested_nonce, completed_nonce, last_error, requested_at
        ) VALUES (?, 1, 0, NULL, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          requested_nonce = requested_nonce + 1,
		  last_error = NULL,
		  requested_at = excluded.requested_at
      `)
			.run(accountId, requestedAt);
		return this.getLibraryRefreshState(accountId).requestedNonce;
	}

	getLibraryRefreshState(accountId: string): LibraryRefreshState {
		const row = this.#db
			.prepare(`
				SELECT requested_nonce, completed_nonce, last_error,
				       requested_at, last_attempt_at, last_success_at
        FROM library_refresh_requests
        WHERE account_id = ?
      `)
			.get(accountId) as LibraryRefreshRow | undefined;
		return row
			? {
					requestedNonce: row.requested_nonce,
					completedNonce: row.completed_nonce,
					lastError: row.last_error,
					requestedAt: row.requested_at,
					lastAttemptAt: row.last_attempt_at,
					lastSuccessAt: row.last_success_at,
				}
			: {
					requestedNonce: 0,
					completedNonce: 0,
					lastError: null,
					requestedAt: null,
					lastAttemptAt: null,
					lastSuccessAt: null,
				};
	}

	completeLibraryRefresh(
		accountId: string,
		requestedNonce: number,
		lastError: string | null,
	): void {
		const attemptedAt = new Date().toISOString();
		this.#db
			.prepare(`
				INSERT INTO library_refresh_requests (
				  account_id, requested_nonce, completed_nonce, last_error,
				  requested_at, last_attempt_at, last_success_at
				)
				SELECT ?, ?, ?, ?, NULL, ?, ?
				WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ?)
				ON CONFLICT(account_id) DO UPDATE SET
				  completed_nonce = excluded.completed_nonce,
				  last_error = excluded.last_error,
				  last_attempt_at = excluded.last_attempt_at,
				  last_success_at = COALESCE(
				    excluded.last_success_at,
				    library_refresh_requests.last_success_at
				  )
				WHERE excluded.completed_nonce >= library_refresh_requests.completed_nonce
			`)
			.run(
				accountId,
				requestedNonce,
				requestedNonce,
				lastError,
				attemptedAt,
				lastError === null ? attemptedAt : null,
				accountId,
			);
	}

	requestCardFarmingScan(accountId: string): number {
		if (!this.get(accountId)) {
			throw new Error(`Account not found: ${accountId}`);
		}
		const requestedAt = new Date().toISOString();
		this.#db
			.prepare(`
				INSERT INTO card_farming_scan_requests (
				  account_id, requested_nonce, completed_nonce, last_error, results_json, requested_at
				) VALUES (?, 1, 0, NULL, '[]', ?)
				ON CONFLICT(account_id) DO UPDATE SET
				  requested_nonce = requested_nonce + 1,
				  last_error = NULL,
				  requested_at = excluded.requested_at
			`)
			.run(accountId, requestedAt);
		return this.getCardFarmingScanState(accountId).requestedNonce;
	}

	getCardFarmingScanState(accountId: string): CardFarmingScanState {
		const row = this.#db
			.prepare(`
				SELECT requested_nonce, completed_nonce, last_error, results_json,
				       requested_at, last_attempt_at, last_success_at
				FROM card_farming_scan_requests
				WHERE account_id = ?
			`)
			.get(accountId) as CardFarmingScanRow | undefined;
		if (!row) {
			return {
				requestedNonce: 0,
				completedNonce: 0,
				lastError: null,
				results: [],
				requestedAt: null,
				lastAttemptAt: null,
				lastSuccessAt: null,
			};
		}
		return {
			requestedNonce: row.requested_nonce,
			completedNonce: row.completed_nonce,
			lastError: row.last_error,
			results: parseCardFarmingQueueJson(row.results_json),
			requestedAt: row.requested_at,
			lastAttemptAt: row.last_attempt_at,
			lastSuccessAt: row.last_success_at,
		};
	}

	completeCardFarmingScan(
		accountId: string,
		requestedNonce: number,
		results: readonly CardFarmingEntry[],
		lastError: string | null,
	): void {
		validateCardFarmingQueue(results);
		const attemptedAt = new Date().toISOString();
		this.#db
			.prepare(`
				INSERT INTO card_farming_scan_requests (
				  account_id, requested_nonce, completed_nonce, last_error, results_json,
				  requested_at, last_attempt_at, last_success_at
				)
				SELECT ?, ?, ?, ?, ?, NULL, ?, ?
				WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ?)
				ON CONFLICT(account_id) DO UPDATE SET
				  completed_nonce = excluded.completed_nonce,
				  last_error = excluded.last_error,
				  results_json = excluded.results_json,
				  last_attempt_at = excluded.last_attempt_at,
				  last_success_at = COALESCE(
				    excluded.last_success_at,
				    card_farming_scan_requests.last_success_at
				  )
				WHERE excluded.completed_nonce >= card_farming_scan_requests.completed_nonce
			`)
			.run(
				accountId,
				requestedNonce,
				requestedNonce,
				lastError,
				JSON.stringify(results),
				attemptedAt,
				lastError === null ? attemptedAt : null,
				accountId,
			);
	}

	writeRuntimeSnapshot(
		accountId: string,
		runnerOwnerId: string,
		snapshot: RuntimeSnapshot,
	): void {
		if (!this.get(accountId)) {
			throw new Error(`Account not found: ${accountId}`);
		}
		this.#db
			.prepare(`
				INSERT INTO runtime_snapshots (
				  account_id, runner_owner_id, snapshot_json, recorded_at
				) VALUES (?, ?, ?, ?)
				ON CONFLICT(account_id) DO UPDATE SET
				  runner_owner_id = excluded.runner_owner_id,
				  snapshot_json = excluded.snapshot_json,
				  recorded_at = excluded.recorded_at
			`)
			.run(
				accountId,
				runnerOwnerId,
				JSON.stringify(snapshot),
				new Date().toISOString(),
			);
	}

	listRuntimeSnapshots(runnerOwnerId?: string): StoredRuntimeSnapshot[] {
		const rows = (
			runnerOwnerId === undefined
				? this.#db
						.prepare(`
							SELECT account_id, runner_owner_id, snapshot_json, recorded_at
							FROM runtime_snapshots
						`)
						.all()
				: this.#db
						.prepare(`
							SELECT account_id, runner_owner_id, snapshot_json, recorded_at
							FROM runtime_snapshots
							WHERE runner_owner_id = ?
						`)
						.all(runnerOwnerId)
		) as RuntimeSnapshotRow[];
		return rows.map((row) => ({
			accountId: row.account_id,
			runnerOwnerId: row.runner_owner_id,
			snapshot: parseRuntimeSnapshot(row.snapshot_json),
			recordedAt: row.recorded_at,
		}));
	}

	delete(id: string): void {
		const result = this.#db
			.prepare("DELETE FROM accounts WHERE id = ?")
			.run(id);
		this.#assertChanged(result.changes, id);
	}

	resetInterruptedStatuses(): void {
		this.#db
			.prepare(`
        UPDATE accounts
        SET status = CASE
          WHEN enabled = 0 THEN 'disabled'
          WHEN auto_restart = 0 AND status = 'backoff' THEN 'error'
          ELSE 'idle'
        END
        WHERE status IN ('connecting', 'online', 'backoff')
      `)
			.run();
	}

	claimRunner(ownerId: string, staleAfterMs = 30_000): boolean {
		const now = Date.now();
		const result = this.#db
			.prepare(`
      INSERT INTO runner_lease (singleton, owner_id, heartbeat_at)
      VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET owner_id = excluded.owner_id, heartbeat_at = excluded.heartbeat_at
      WHERE runner_lease.owner_id = excluded.owner_id OR runner_lease.heartbeat_at < ?
    `)
			.run(ownerId, now, now - staleAfterMs);
		return result.changes > 0;
	}

	heartbeatRunner(ownerId: string): void {
		const result = this.#db
			.prepare(
				"UPDATE runner_lease SET heartbeat_at = ? WHERE singleton = 1 AND owner_id = ?",
			)
			.run(Date.now(), ownerId);
		if (result.changes === 0) {
			throw new Error("Linger runner lost its database lease");
		}
	}

	releaseRunner(ownerId: string): void {
		this.#db
			.prepare("DELETE FROM runner_lease WHERE singleton = 1 AND owner_id = ?")
			.run(ownerId);
	}

	hasActiveRunner(staleAfterMs = 30_000): boolean {
		return this.getActiveRunnerLease(staleAfterMs) !== null;
	}

	getActiveRunnerLease(staleAfterMs = 30_000): RunnerLease | null {
		const row = this.#db
			.prepare(
				"SELECT owner_id, heartbeat_at FROM runner_lease WHERE singleton = 1 AND heartbeat_at >= ?",
			)
			.get(Date.now() - staleAfterMs) as
			| { owner_id: string; heartbeat_at: number }
			| undefined;
		return row
			? {
					ownerId: row.owner_id,
					heartbeatAt: new Date(row.heartbeat_at).toISOString(),
				}
			: null;
	}

	#require(id: string): Account {
		const account = this.get(id);
		if (!account) {
			throw new Error(`Account not found: ${id}`);
		}
		return account;
	}

	#assertChanged(changes: number | bigint, id: string): void {
		if (changes === 0 || changes === 0n) {
			throw new Error(`Account not found: ${id}`);
		}
	}

	#migrate(): void {
		const versionRow = this.#db.prepare("PRAGMA user_version").get() as {
			user_version: number;
		};
		const version = versionRow.user_version;
		if (version > 12) {
			throw new Error(
				`Database schema ${version} is newer than this version of Linger supports`,
			);
		}
		if (version === 0) {
			this.#db.exec("BEGIN IMMEDIATE");
			try {
				this.#db.exec(`
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          account_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
          steam_id TEXT,
          refresh_token_encrypted TEXT NOT NULL,
          machine_auth_token_encrypted TEXT,
          app_ids_json TEXT NOT NULL,
          custom_game TEXT,
          visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          revision INTEGER NOT NULL,
          restart_nonce INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('disabled', 'idle', 'connecting', 'online', 'backoff', 'needs_auth', 'error')),
          last_error TEXT,
          last_connected_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        PRAGMA user_version = 1;
      `);
				this.#db.exec("COMMIT");
			} catch (error) {
				this.#db.exec("ROLLBACK");
				throw error;
			}
		}

		if (version <= 1) {
			this.#db.exec(`
        CREATE TABLE runner_lease (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          owner_id TEXT NOT NULL,
          heartbeat_at INTEGER NOT NULL
        );
        PRAGMA user_version = 2;
      `);
		}

		if (version <= 2) {
			this.#db.exec(`
        ALTER TABLE accounts ADD COLUMN clear_recent_activity INTEGER NOT NULL DEFAULT 0
          CHECK (clear_recent_activity IN (0, 1));
        PRAGMA user_version = 3;
      `);
		}

		if (version <= 3) {
			this.#db.exec(`
        CREATE TABLE owned_games (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          app_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          playtime_forever INTEGER NOT NULL CHECK (playtime_forever >= 0),
          PRIMARY KEY (account_id, app_id)
        );
        PRAGMA user_version = 4;
      `);
		}

		if (version <= 4) {
			this.#db.exec(`
        ALTER TABLE accounts ADD COLUMN card_farming_enabled INTEGER NOT NULL DEFAULT 0
          CHECK (card_farming_enabled IN (0, 1));
        ALTER TABLE accounts ADD COLUMN card_farming_queue_json TEXT NOT NULL DEFAULT '[]';
        PRAGMA user_version = 5;
      `);
		}

		if (version <= 5) {
			this.#db.exec(`
        CREATE TABLE library_refresh_requests (
          account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          requested_nonce INTEGER NOT NULL,
          completed_nonce INTEGER NOT NULL,
          last_error TEXT
        );
        PRAGMA user_version = 6;
			`);
		}

		if (version <= 6) {
			this.#db.exec(`
        ALTER TABLE accounts ADD COLUMN away_message TEXT;
        PRAGMA user_version = 7;
      `);
		}

		if (version <= 7) {
			this.#db.exec(`
        ALTER TABLE accounts ADD COLUMN auto_stop_targets_json TEXT NOT NULL DEFAULT '[]';
        PRAGMA user_version = 8;
			`);
		}

		if (version <= 8) {
			this.#db.exec(`
        CREATE TABLE tracked_playtimes (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          app_id INTEGER NOT NULL,
          playtime_forever INTEGER NOT NULL CHECK (playtime_forever >= 0),
          PRIMARY KEY (account_id, app_id)
        );
        INSERT INTO tracked_playtimes (account_id, app_id, playtime_forever)
        SELECT account_id, app_id, playtime_forever FROM owned_games;
        PRAGMA user_version = 9;
      `);
		}

		if (version <= 9) {
			this.#db.exec(`
        ALTER TABLE accounts ADD COLUMN auto_restart INTEGER NOT NULL DEFAULT 1
          CHECK (auto_restart IN (0, 1));
        PRAGMA user_version = 10;
      `);
		}

		if (version <= 10) {
			this.#db.exec("BEGIN IMMEDIATE");
			try {
				this.#db.exec(`
				ALTER TABLE library_refresh_requests ADD COLUMN requested_at TEXT;
				ALTER TABLE library_refresh_requests ADD COLUMN last_attempt_at TEXT;
				ALTER TABLE library_refresh_requests ADD COLUMN last_success_at TEXT;
				CREATE TABLE runtime_snapshots (
				  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
				  runner_owner_id TEXT NOT NULL,
				  snapshot_json TEXT NOT NULL,
				  recorded_at TEXT NOT NULL
				);
				PRAGMA user_version = 11;
			`);
				this.#db.exec("COMMIT");
			} catch (error) {
				this.#db.exec("ROLLBACK");
				throw error;
			}
		}

		if (version <= 11) {
			this.#db.exec("BEGIN IMMEDIATE");
			try {
				this.#db.exec(`
					ALTER TABLE accounts ADD COLUMN card_farming_exclusions_json TEXT NOT NULL DEFAULT '[]';
					ALTER TABLE accounts ADD COLUMN card_farming_policy TEXT NOT NULL DEFAULT 'manual'
					  CHECK (card_farming_policy IN ('manual', 'fewest_drops', 'least_played'));
					ALTER TABLE accounts ADD COLUMN card_farming_rescan INTEGER NOT NULL DEFAULT 0
					  CHECK (card_farming_rescan IN (0, 1));
					CREATE TABLE card_farming_scan_requests (
					  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
					  requested_nonce INTEGER NOT NULL,
					  completed_nonce INTEGER NOT NULL,
					  last_error TEXT,
					  results_json TEXT NOT NULL DEFAULT '[]',
					  requested_at TEXT,
					  last_attempt_at TEXT,
					  last_success_at TEXT
					);
					PRAGMA user_version = 12;
				`);
				this.#db.exec("COMMIT");
			} catch (error) {
				this.#db.exec("ROLLBACK");
				throw error;
			}
		}
	}
}
