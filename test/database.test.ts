import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { AccountStore } from "../src/database.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createStore(): AccountStore {
	const directory = mkdtempSync(path.join(tmpdir(), "linger-test-"));
	temporaryDirectories.push(directory);
	return new AccountStore(path.join(directory, "linger.sqlite"));
}

describe("AccountStore", () => {
	it("creates and reconfigures an account", () => {
		const store = createStore();
		const account = store.create({
			accountName: "vocal",
			steamId: "76561198000000000",
			refreshTokenEncrypted: "encrypted",
			machineAuthTokenEncrypted: null,
			appIds: [730],
			autoStopTargets: [],
			customGame: null,
			visible: true,
			clearRecentActivity: false,
			cardFarmingEnabled: false,
			enabled: true,
		});

		assert.equal(store.getByName("VOCAL")?.id, account.id);
		assert.equal(account.autoRestart, true);
		const updated = store.updateConfiguration(account.id, {
			appIds: [440, 570],
			autoStopTargets: [],
			customGame: "Linger",
			visible: false,
			clearRecentActivity: true,
		});
		assert.deepEqual(updated.appIds, [440, 570]);
		assert.equal(updated.customGame, "Linger");
		assert.equal(updated.visible, false);
		assert.equal(updated.clearRecentActivity, true);
		assert.equal(updated.revision, account.revision + 1);
		const withAwayMessage = store.setAwayMessage(
			account.id,
			"  I am away right now.  ",
		);
		assert.equal(withAwayMessage.awayMessage, "I am away right now.");
		assert.equal(withAwayMessage.revision, updated.revision + 1);
		assert.equal(store.setAwayMessage(account.id, "  ").awayMessage, null);
		assert.equal(store.setAutoRestart(account.id, false).autoRestart, false);
		assert.equal(store.setAutoRestart(account.id, true).autoRestart, true);
		store.close();
	});

	it("supports runtime updates without changing configuration revision", () => {
		const store = createStore();
		const account = store.create({
			accountName: "runtime-test",
			steamId: null,
			refreshTokenEncrypted: "encrypted",
			machineAuthTokenEncrypted: null,
			appIds: [730],
			autoStopTargets: [],
			customGame: null,
			visible: true,
			clearRecentActivity: false,
			cardFarmingEnabled: false,
			autoRestart: true,
			enabled: true,
		});
		const updated = store.updateRuntime(account.id, {
			status: "online",
			lastError: null,
		});
		assert.equal(updated.status, "online");
		assert.equal(updated.revision, account.revision);
		store.close();
	});

	it("preserves an opted-out disconnect across runner restarts", () => {
		const store = createStore();
		const account = store.create({
			accountName: "manual-restart",
			steamId: null,
			refreshTokenEncrypted: "encrypted",
			machineAuthTokenEncrypted: null,
			appIds: [730],
			autoStopTargets: [],
			customGame: null,
			visible: true,
			clearRecentActivity: false,
			cardFarmingEnabled: false,
			autoRestart: false,
			enabled: true,
		});

		store.updateRuntime(account.id, {
			status: "backoff",
			lastError: "Steam disconnected",
		});
		store.resetInterruptedStatuses();
		assert.equal(store.get(account.id)?.status, "error");

		store.setAutoRestart(account.id, true);
		store.updateRuntime(account.id, { status: "backoff" });
		store.resetInterruptedStatuses();
		assert.equal(store.get(account.id)?.status, "idle");
		store.close();
	});

	it("replaces and reads the cached game library", () => {
		const store = createStore();
		const account = store.create({
			accountName: "library-test",
			steamId: "76561198000000000",
			refreshTokenEncrypted: "encrypted",
			machineAuthTokenEncrypted: null,
			appIds: [730],
			autoStopTargets: [],
			customGame: null,
			visible: true,
			clearRecentActivity: false,
			cardFarmingEnabled: false,
			autoRestart: true,
			enabled: true,
		});

		store.replaceOwnedGames(account.id, [
			{ appId: 730, name: " Counter-Strike 2 ", playtimeForever: 600 },
			{ appId: 440, name: "Team Fortress 2", playtimeForever: 120 },
			{ appId: 0, name: "Invalid", playtimeForever: 1 },
		]);
		assert.deepEqual(
			store
				.listOwnedGames(account.id)
				.sort((left, right) => left.appId - right.appId),
			[
				{ appId: 440, name: "Team Fortress 2", playtimeForever: 120 },
				{ appId: 730, name: "Counter-Strike 2", playtimeForever: 600 },
			],
		);

		store.replaceOwnedGames(account.id, [
			{ appId: 570, name: "Dota 2", playtimeForever: 30 },
		]);
		assert.deepEqual(store.listOwnedGames(account.id), [
			{ appId: 570, name: "Dota 2", playtimeForever: 30 },
		]);

		store.replaceTrackedPlaytimes(
			account.id,
			new Map([
				[7, 86_040],
				[730, 87_541],
			]),
		);
		assert.deepEqual(
			[...store.listTrackedPlaytimes(account.id)].sort(
				([left], [right]) => left - right,
			),
			[
				[7, 86_040],
				[730, 87_541],
			],
		);
		store.close();
	});

	it("coordinates game-library refresh requests with the runner", () => {
		const store = createStore();
		const account = store.create({
			accountName: "library-refresh-test",
			steamId: "76561198000000000",
			refreshTokenEncrypted: "encrypted",
			machineAuthTokenEncrypted: null,
			appIds: [730],
			autoStopTargets: [],
			customGame: null,
			visible: true,
			clearRecentActivity: false,
			cardFarmingEnabled: false,
			autoRestart: true,
			enabled: true,
		});

		assert.deepEqual(store.getLibraryRefreshState(account.id), {
			requestedNonce: 0,
			completedNonce: 0,
			lastError: null,
			requestedAt: null,
			lastAttemptAt: null,
			lastSuccessAt: null,
		});
		const first = store.requestLibraryRefresh(account.id);
		assert.equal(first, 1);
		store.completeLibraryRefresh(account.id, first, "Steam unavailable");
		const failed = store.getLibraryRefreshState(account.id);
		assert.equal(failed.requestedNonce, 1);
		assert.equal(failed.completedNonce, 1);
		assert.equal(failed.lastError, "Steam unavailable");
		assert.ok(failed.requestedAt);
		assert.ok(failed.lastAttemptAt);
		assert.equal(failed.lastSuccessAt, null);

		const second = store.requestLibraryRefresh(account.id);
		assert.equal(second, 2);
		assert.equal(store.getLibraryRefreshState(account.id).lastError, null);
		store.completeLibraryRefresh(account.id, second, null);
		const completed = store.getLibraryRefreshState(account.id);
		assert.equal(completed.requestedNonce, 2);
		assert.equal(completed.completedNonce, 2);
		assert.equal(completed.lastError, null);
		assert.ok(completed.lastSuccessAt);
		store.delete(account.id);
		assert.doesNotThrow(() =>
			store.completeLibraryRefresh(account.id, second, null),
		);
		store.close();
	});

	it("persists runtime snapshots with their runner owner", () => {
		const store = createStore();
		const account = store.create({
			accountName: "snapshot-test",
			steamId: null,
			refreshTokenEncrypted: "encrypted",
			machineAuthTokenEncrypted: null,
			appIds: [730],
			autoStopTargets: [],
			customGame: null,
			visible: true,
			clearRecentActivity: false,
			cardFarmingEnabled: false,
			autoRestart: true,
			enabled: true,
		});
		const activitySince = "2026-08-20T10:00:00.000Z";
		store.writeRuntimeSnapshot(account.id, "runner-one", {
			version: 1,
			activity: {
				kind: "boosting",
				appIds: [730],
				customGame: null,
				autoStop: [],
			},
			activitySince,
			sessionStartedAt: activitySince,
			externalAppId: null,
		});

		const [stored] = store.listRuntimeSnapshots();
		assert.equal(stored?.accountId, account.id);
		assert.equal(stored?.runnerOwnerId, "runner-one");
		assert.equal(stored?.snapshot.activity.kind, "boosting");
		assert.ok(stored?.recordedAt);
		assert.equal(store.listRuntimeSnapshots("runner-one").length, 1);
		assert.deepEqual(store.listRuntimeSnapshots("runner-two"), []);
		store.close();
	});

	it("allows only one active runner lease", () => {
		const store = createStore();
		assert.equal(store.hasActiveRunner(), false);
		assert.equal(store.claimRunner("runner-one"), true);
		assert.equal(store.hasActiveRunner(), true);
		assert.equal(store.claimRunner("runner-two"), false);
		assert.doesNotThrow(() => store.heartbeatRunner("runner-one"));
		store.releaseRunner("runner-one");
		assert.equal(store.claimRunner("runner-two"), true);
		store.close();
	});

	it("migrates existing accounts with recent-activity clearing disabled", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "linger-test-"));
		temporaryDirectories.push(directory);
		const databasePath = path.join(directory, "linger.sqlite");
		const database = new DatabaseSync(databasePath);
		database.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        account_name TEXT NOT NULL UNIQUE,
        steam_id TEXT,
        refresh_token_encrypted TEXT NOT NULL,
        machine_auth_token_encrypted TEXT,
        app_ids_json TEXT NOT NULL,
        custom_game TEXT,
        visible INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        restart_nonce INTEGER NOT NULL,
        status TEXT NOT NULL,
        last_error TEXT,
        last_connected_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE runner_lease (
        singleton INTEGER PRIMARY KEY,
        owner_id TEXT NOT NULL,
        heartbeat_at INTEGER NOT NULL
      );
      INSERT INTO accounts VALUES (
        'id', 'existing', NULL, 'encrypted', NULL, '[730]', NULL, 1, 1, 1, 0,
        'idle', NULL, NULL, 'now', 'now'
      );
      PRAGMA user_version = 2;
    `);
		database.close();

		const store = new AccountStore(databasePath);
		assert.equal(store.get("id")?.clearRecentActivity, false);
		assert.equal(store.get("id")?.cardFarmingEnabled, false);
		assert.deepEqual(store.get("id")?.cardFarmingQueue, []);
		assert.equal(store.get("id")?.awayMessage, null);
		assert.deepEqual(store.get("id")?.autoStopTargets, []);
		assert.equal(store.get("id")?.autoRestart, true);
		assert.deepEqual([...store.listTrackedPlaytimes("id")], []);
		store.close();
		const migrated = new DatabaseSync(databasePath, { readOnly: true });
		assert.equal(
			(
				migrated.prepare("PRAGMA user_version").get() as {
					user_version: number;
				}
			).user_version,
			11,
		);
		assert.deepEqual(
			migrated
				.prepare("PRAGMA table_info(runtime_snapshots)")
				.all()
				.map((column) => (column as { name: string }).name),
			["account_id", "runner_owner_id", "snapshot_json", "recorded_at"],
		);
		migrated.close();
	});

	it("persists and completes per-game auto-stop targets", () => {
		const store = createStore();
		const account = store.create({
			accountName: "auto-stop-test",
			steamId: "76561198000000000",
			refreshTokenEncrypted: "encrypted",
			machineAuthTokenEncrypted: null,
			appIds: [730, 440],
			autoStopTargets: [{ appId: 730, targetMinutes: 7_777 * 60 }],
			customGame: null,
			visible: true,
			clearRecentActivity: false,
			cardFarmingEnabled: true,
			autoRestart: true,
			enabled: true,
		});
		store.replaceCardFarmingQueue(account.id, [
			{ appId: 730, remainingDrops: 2 },
		]);

		assert.deepEqual(account.autoStopTargets, [
			{ appId: 730, targetMinutes: 7_777 * 60 },
		]);
		const completed = store.completeAutoStop(account.id, 730);
		assert.deepEqual(completed.appIds, [440]);
		assert.deepEqual(completed.autoStopTargets, []);
		assert.deepEqual(completed.cardFarmingQueue, [
			{ appId: 730, remainingDrops: 2 },
		]);
		assert.equal(completed.enabled, true);
		assert.equal(completed.revision, account.revision + 1);
		store.close();
	});

	it("persists card queues and disables farming after completion", () => {
		const store = createStore();
		const account = store.create({
			accountName: "cards-only",
			steamId: null,
			refreshTokenEncrypted: "encrypted",
			machineAuthTokenEncrypted: null,
			appIds: [],
			autoStopTargets: [],
			customGame: null,
			visible: false,
			clearRecentActivity: false,
			cardFarmingEnabled: true,
			autoRestart: true,
			enabled: true,
		});

		const queued = store.replaceCardFarmingQueue(account.id, [
			{ appId: 440, remainingDrops: 2 },
		]);
		assert.deepEqual(queued.cardFarmingQueue, [
			{ appId: 440, remainingDrops: 2 },
		]);

		const finished = store.finishCardFarming(account.id);
		assert.equal(finished.cardFarmingEnabled, false);
		assert.deepEqual(finished.cardFarmingQueue, []);
		assert.equal(finished.enabled, false);
		assert.equal(finished.status, "disabled");
		store.close();
	});
});
