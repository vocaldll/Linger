import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { CredentialVault } from "../src/crypto.js";
import { AccountStore } from "../src/database.js";
import { Runner } from "../src/runner.js";
import { createSteamMachineIdentity } from "../src/steam/machine-identity.js";

describe("Runner", () => {
	it("starts, stops, and releases its database lease", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "linger-runner-test-"));
		const store = new AccountStore(path.join(directory, "linger.sqlite"));
		try {
			const runner = new Runner(
				store,
				new CredentialVault("runner lifecycle test master key"),
				createSteamMachineIdentity("runner-test-device"),
				10,
			);
			const running = runner.start();
			await new Promise<void>((resolve) => setImmediate(resolve));
			await runner.stop();
			await running;
			assert.equal(store.claimRunner("next-runner"), true);
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
