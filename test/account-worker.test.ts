import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import SteamUser from "steam-user";
import { CredentialVault } from "../src/crypto.js";
import { AccountStore } from "../src/database.js";
import type { Account } from "../src/domain/account.js";
import {
	AccountWorker,
	AWAY_MESSAGE_COOLDOWN_MS,
	AwayMessageCooldown,
	assessProfileStatus,
	buildAccountPresenceIntent,
	calculateAutoStopCheckDelay,
	extendEarlyRetryProtection,
	findReachedAutoStopTargets,
	guardWebLogOnAfterDisconnect,
	presenceChanged,
	selectCurrentAutoStopTargets,
} from "../src/steam/account-worker.js";
import { createSteamMachineIdentity } from "../src/steam/machine-identity.js";

function account(overrides: Partial<Account> = {}): Account {
	return {
		id: "id",
		accountName: "account",
		steamId: "1",
		refreshTokenEncrypted: "encrypted",
		machineAuthTokenEncrypted: null,
		appIds: [730, 440],
		autoStopTargets: [],
		customGame: null,
		awayMessage: null,
		visible: false,
		clearRecentActivity: true,
		cardFarmingEnabled: false,
		cardFarmingQueue: [],
		cardFarmingExclusions: [],
		cardFarmingPolicy: "manual",
		cardFarmingRescan: false,
		autoRestart: true,
		enabled: true,
		pausedUntil: null,
		revision: 1,
		restartNonce: 0,
		status: "online",
		lastError: null,
		lastConnectedAt: null,
		createdAt: "2026-08-19T00:00:00.000Z",
		updatedAt: "2026-08-19T00:00:00.000Z",
		...overrides,
	};
}

describe("Steam account worker", () => {
	for (const fails of [false, true]) {
		it(`refreshes a disabled account invisibly and disconnects after ${fails ? "failure" : "success"}`, async (context) => {
			const store = new AccountStore(":memory:");
			const vault = new CredentialVault("account worker test master key");
			context.mock.method(
				SteamUser.prototype,
				"logOn",
				function (this: SteamUser) {
					Object.defineProperty(this, "steamID", {
						value: { getSteamID64: () => "76561198000000000" },
						configurable: true,
					});
					Object.defineProperty(this, "_send", {
						value: () => {
							throw new Error("Tracked playtime unavailable in fixture");
						},
					});
					this.emit("loggedOn", {});
				},
			);
			const logOff = context.mock.method(
				SteamUser.prototype,
				"logOff",
				() => {},
			);
			const persona = context.mock.method(
				SteamUser.prototype,
				"setPersona",
				() => {},
			);
			const gamesPlayed = context.mock.method(
				SteamUser.prototype,
				"gamesPlayed",
				() => {},
			);
			context.mock.method(SteamUser.prototype, "getUserOwnedApps", async () => {
				if (fails) throw new Error("Library unavailable");
				return {
					apps: [{ appid: 730, name: "Test game", playtime_forever: 42 }],
				};
			});
			const persisted = store.create({
				accountName: "account",
				steamId: null,
				refreshTokenEncrypted: vault.encrypt("refresh-token"),
				machineAuthTokenEncrypted: null,
				appIds: [730],
				autoStopTargets: [],
				customGame: null,
				visible: true,
				clearRecentActivity: true,
				cardFarmingEnabled: false,
				enabled: false,
			});
			const worker = new AccountWorker(
				store,
				vault,
				persisted,
				createSteamMachineIdentity("worker-test-device"),
				"runner",
			);
			try {
				const nonce = store.requestLibraryRefresh(persisted.id);
				worker.reconcile(persisted);
				await new Promise<void>((resolve) => setImmediate(resolve));
				const refresh = store.getLibraryRefreshState(persisted.id);
				assert.equal(refresh.completedNonce, nonce);
				assert.equal(refresh.lastError, fails ? "Library unavailable" : null);
				assert.deepEqual(
					store.listOwnedGames(persisted.id),
					fails ? [] : [{ appId: 730, name: "Test game", playtimeForever: 42 }],
				);
				assert.equal(store.get(persisted.id)?.enabled, false);
				assert.deepEqual(
					persona.mock.calls.map((call) => call.arguments[0]),
					[SteamUser.EPersonaState.Invisible],
				);
				assert.deepEqual(
					gamesPlayed.mock.calls.map((call) => call.arguments[0]),
					[[]],
				);
				const current = store.get(persisted.id);
				assert.ok(current);
				worker.reconcile(current);
				assert.equal(logOff.mock.callCount(), 1);
				assert.equal(store.get(persisted.id)?.status, "disabled");
			} finally {
				worker.stop();
				store.close();
			}
		});
	}

	it("backs off when a connection attempt never completes", (context) => {
		context.mock.timers.enable({ apis: ["setTimeout"] });
		context.mock.method(SteamUser.prototype, "logOn", () => {});
		context.mock.method(SteamUser.prototype, "logOff", () => {});
		const directory = mkdtempSync(path.join(tmpdir(), "linger-worker-test-"));
		const store = new AccountStore(path.join(directory, "linger.sqlite"));
		const vault = new CredentialVault("account worker test master key");
		try {
			const persisted = store.create({
				accountName: "account",
				steamId: "76561198000000000",
				refreshTokenEncrypted: vault.encrypt("refresh-token"),
				machineAuthTokenEncrypted: null,
				appIds: [730],
				autoStopTargets: [],
				customGame: null,
				visible: false,
				clearRecentActivity: false,
				cardFarmingEnabled: false,
				autoRestart: true,
				enabled: true,
			});
			const worker = new AccountWorker(
				store,
				vault,
				persisted,
				createSteamMachineIdentity("worker-test-device"),
				"runner",
			);

			worker.reconcile(persisted);
			assert.equal(store.get(persisted.id)?.status, "connecting");

			context.mock.timers.tick(2 * 60 * 1_000);

			const failed = store.get(persisted.id);
			assert.equal(failed?.status, "backoff");
			assert.equal(failed?.lastError, "Steam connection attempt timed out");
			worker.stop();
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("keeps scan-only connections invisible and clears played games", () => {
		assert.deepEqual(
			buildAccountPresenceIntent(
				account({
					enabled: false,
					visible: true,
					cardFarmingEnabled: true,
					cardFarmingQueue: [{ appId: 440, remainingDrops: 2 }],
				}),
			),
			{ mode: "farm", appId: null, visible: false },
		);
	});

	it("schedules the next auto-stop from current Steam minutes", () => {
		const targets = [
			{ appId: 730, targetMinutes: 7_777 * 60 },
			{ appId: 440, targetMinutes: 1_000 },
		];
		const playtimes = new Map([
			[730, 7_777 * 60 - 1],
			[440, 0],
		]);
		assert.equal(
			calculateAutoStopCheckDelay(targets, playtimes, 10_000),
			50_000,
		);
	});

	it("does not classify auto-stop target edits as presence changes", () => {
		const previous = account();
		const next = account({
			autoStopTargets: [{ appId: 730, targetMinutes: 7_777 * 60 }],
		});

		assert.equal(presenceChanged(previous, next), false);
		assert.equal(presenceChanged(previous, account({ appIds: [730] })), true);
	});

	it("reaches auto-stop targets from locally elapsed boosting time", () => {
		const targets = [
			{ appId: 730, targetMinutes: 100 },
			{ appId: 440, targetMinutes: 200 },
		];
		const playtimes = new Map([
			[730, 99],
			[440, 198],
		]);

		assert.deepEqual(findReachedAutoStopTargets(targets, playtimes, 60_000), [
			targets[0],
		]);
		assert.deepEqual(
			findReachedAutoStopTargets(targets, playtimes, 120_000),
			targets,
		);
	});

	it("completes only targets from the current persisted configuration", () => {
		const target = { appId: 730, targetMinutes: 100 };
		const snapshot = account({ autoStopTargets: [target] });

		assert.deepEqual(
			selectCurrentAutoStopTargets(snapshot, snapshot, [target]),
			[target],
		);
		assert.deepEqual(
			selectCurrentAutoStopTargets(
				snapshot,
				account({ revision: 2, autoStopTargets: [target] }),
				[target],
			),
			[target],
		);
		assert.deepEqual(
			selectCurrentAutoStopTargets(
				snapshot,
				account({
					revision: 2,
					autoStopTargets: [{ ...target, targetMinutes: 200 }],
				}),
				[target],
			),
			[],
		);
		assert.deepEqual(
			selectCurrentAutoStopTargets(
				snapshot,
				account({ autoStopTargets: [target], cardFarmingEnabled: true }),
				[target],
			),
			[],
		);
		assert.deepEqual(
			selectCurrentAutoStopTargets(
				snapshot,
				account({ appIds: [730], autoStopTargets: [target] }),
				[target],
			),
			[],
		);
	});

	it("allows one away reply per sender every 30 minutes", () => {
		const cooldown = new AwayMessageCooldown();
		const firstReplyAt = 1_000;
		assert.equal(cooldown.reserve("sender-a", firstReplyAt), firstReplyAt);
		assert.equal(
			cooldown.reserve("sender-a", firstReplyAt + AWAY_MESSAGE_COOLDOWN_MS - 1),
			null,
		);
		assert.equal(
			cooldown.reserve("sender-a", firstReplyAt + AWAY_MESSAGE_COOLDOWN_MS),
			firstReplyAt + AWAY_MESSAGE_COOLDOWN_MS,
		);
		assert.equal(
			cooldown.reserve("sender-b", firstReplyAt + 1),
			firstReplyAt + 1,
		);
	});

	it("releases the away-message cooldown after a failed send", () => {
		const cooldown = new AwayMessageCooldown();
		const replyAt = cooldown.reserve("sender", 1_000);
		assert.equal(replyAt, 1_000);
		cooldown.release("sender", 1_000);
		assert.equal(cooldown.reserve("sender", 1_001), 1_001);
	});

	it("skips steam-user's stale automatic web logon after a disconnect", () => {
		let calls = 0;
		const client = {
			steamID: null as object | null,
			webLogOn() {
				calls += 1;
			},
		};

		guardWebLogOnAfterDisconnect(client);
		client.webLogOn();
		assert.equal(calls, 0);

		client.steamID = {};
		client.webLogOn();
		assert.equal(calls, 1);
	});

	it("requires two consecutive online observations before retrying", () => {
		assert.deepEqual(assessProfileStatus("online", null, 0), {
			action: "wait",
			lastStatus: "online",
			consecutiveMatches: 1,
		});
		assert.deepEqual(assessProfileStatus("online", "online", 1), {
			action: "retry",
			mode: "confirmed-exit",
		});
		assert.deepEqual(assessProfileStatus("in-game", "online", 1), {
			action: "wait",
			lastStatus: null,
			consecutiveMatches: 0,
		});
	});

	it("probes once after two consecutive offline observations", () => {
		assert.deepEqual(assessProfileStatus("offline", null, 0), {
			action: "wait",
			lastStatus: "offline",
			consecutiveMatches: 1,
		});
		assert.deepEqual(assessProfileStatus("offline", "offline", 1), {
			action: "retry",
			mode: "offline-probe",
		});
		assert.deepEqual(assessProfileStatus("offline", "online", 1), {
			action: "wait",
			lastStatus: "offline",
			consecutiveMatches: 1,
		});
	});

	it("falls back when profile status is not observable", () => {
		assert.deepEqual(assessProfileStatus("unknown", "online", 1), {
			action: "fallback",
		});
	});

	it("keeps an early retry protected while the connection settles", () => {
		assert.equal(
			extendEarlyRetryProtection(Number.POSITIVE_INFINITY, 1_000),
			31_000,
		);
		assert.equal(extendEarlyRetryProtection(0, 1_000), 0);
	});
});
