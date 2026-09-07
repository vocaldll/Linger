import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import SteamUser from "steam-user";
import { CredentialVault } from "../src/crypto.js";
import { AccountStore } from "../src/database.js";
import { Runner } from "../src/runner.js";
import { createSteamMachineIdentity } from "../src/steam/machine-identity.js";

describe("Runner", () => {
	it("resumes overdue pauses at startup and stops and resumes a paused worker", async (context) => {
		context.mock.timers.enable({
			apis: ["Date", "setTimeout"],
			now: 1_000_000,
		});
		const logOn = context.mock.method(SteamUser.prototype, "logOn", () => {});
		const logOff = context.mock.method(SteamUser.prototype, "logOff", () => {});
		const store = new AccountStore(":memory:");
		const vault = new CredentialVault("runner pause test master key");
		const account = store.create({
			accountName: "paused",
			steamId: null,
			refreshTokenEncrypted: vault.encrypt("fixture"),
			machineAuthTokenEncrypted: null,
			appIds: [730],
			autoStopTargets: [],
			customGame: null,
			visible: false,
			clearRecentActivity: false,
			cardFarmingEnabled: false,
			autoRestart: false,
			enabled: true,
		});
		store.pauseUntil(account.id, new Date(Date.now() + 1_000).toISOString());
		context.mock.timers.tick(1_000);
		const runner = new Runner(
			store,
			vault,
			createSteamMachineIdentity("runner-test-device"),
			1_000,
		);
		const running = runner.start();
		try {
			assert.equal(logOn.mock.callCount(), 1);
			assert.equal(store.get(account.id)?.pausedUntil, null);
			store.pauseUntil(account.id, new Date(Date.now() + 3_000).toISOString());
			context.mock.timers.tick(1_000);
			await Promise.resolve();
			assert.equal(logOff.mock.callCount(), 1);
			assert.equal(store.get(account.id)?.enabled, false);
			context.mock.timers.tick(1_000);
			await Promise.resolve();
			assert.equal(logOn.mock.callCount(), 1);
			context.mock.timers.tick(1_000);
			await Promise.resolve();
			assert.equal(logOn.mock.callCount(), 2);
			assert.equal(store.get(account.id)?.enabled, true);
		} finally {
			await runner.stop();
			await running;
			store.close();
		}
	});

	it("keeps its lease alive between slow configuration polls", async (context) => {
		context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
		const store = new AccountStore(":memory:");
		const list = context.mock.method(store, "list");
		const runner = new Runner(
			store,
			new CredentialVault("runner test key"),
			createSteamMachineIdentity("runner-test-device"),
			60_000,
		);
		const running = runner.start();
		try {
			for (let tick = 0; tick < 5; tick += 1) {
				context.mock.timers.tick(10_000);
				await Promise.resolve();
				assert.equal(store.hasActiveRunner(), true);
				assert.equal(store.claimRunner("second-runner"), false);
			}
			assert.equal(list.mock.callCount(), 1);
			context.mock.timers.tick(10_000);
			await Promise.resolve();
			assert.equal(list.mock.callCount(), 2);
		} finally {
			await runner.stop();
			await running;
			assert.equal(store.claimRunner("second-runner"), true);
			store.close();
		}
	});

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
