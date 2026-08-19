import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Account } from "../src/domain/account.js";
import {
	AWAY_MESSAGE_COOLDOWN_MS,
	AwayMessageCooldown,
	assessProfileStatus,
	calculateAutoStopCheckDelay,
	extendEarlyRetryProtection,
	findReachedAutoStopTargets,
	guardWebLogOnAfterDisconnect,
	presenceChanged,
	selectCurrentAutoStopTargets,
} from "../src/steam/account-worker.js";

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
		enabled: true,
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
