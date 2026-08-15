import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assessGameExit,
	guardWebLogOnAfterDisconnect,
} from "../src/steam/account-worker.js";

describe("Steam account worker", () => {
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

	it("requires two consecutive confirmations before retrying", () => {
		assert.deepEqual(assessGameExit("not-playing", 0), {
			action: "wait",
			consecutiveNotPlaying: 1,
		});
		assert.deepEqual(assessGameExit("not-playing", 1), { action: "retry" });
		assert.deepEqual(assessGameExit("playing", 1), {
			action: "wait",
			consecutiveNotPlaying: 0,
		});
	});

	it("falls back when game status is not observable", () => {
		assert.deepEqual(assessGameExit("unknown", 1), { action: "fallback" });
	});
});
