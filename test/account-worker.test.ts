import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AWAY_MESSAGE_COOLDOWN_MS,
	AwayMessageCooldown,
	assessProfileStatus,
	calculateAutoStopCheckDelay,
	extendEarlyRetryProtection,
	guardWebLogOnAfterDisconnect,
} from "../src/steam/account-worker.js";

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
