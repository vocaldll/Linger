import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guardWebLogOnAfterDisconnect } from "../src/steam/account-worker.js";

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
});
