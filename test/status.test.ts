import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { AccountStore } from "../src/database.js";
import { parseRuntimeSnapshot } from "../src/domain/runtime-snapshot.js";
import { buildFleetStatus, formatFleetStatus } from "../src/status.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createStore(): AccountStore {
	return createDatabase().store;
}

function createDatabase(): { databasePath: string; store: AccountStore } {
	const directory = mkdtempSync(path.join(tmpdir(), "linger-status-test-"));
	temporaryDirectories.push(directory);
	const databasePath = path.join(directory, "linger.sqlite");
	return { databasePath, store: new AccountStore(databasePath) };
}

function createAccount(store: AccountStore) {
	return store.create({
		accountName: "vocal",
		steamId: "76561198000000000",
		refreshTokenEncrypted: "encrypted",
		machineAuthTokenEncrypted: null,
		appIds: [730],
		autoStopTargets: [{ appId: 730, targetMinutes: 120 }],
		customGame: null,
		visible: true,
		clearRecentActivity: false,
		cardFarmingEnabled: false,
		autoRestart: true,
		enabled: true,
	});
}

describe("fleet status", () => {
	it("enriches a current boosting snapshot with names and progress", () => {
		const store = createStore();
		const account = createAccount(store);
		store.replaceOwnedGames(account.id, [
			{
				appId: 730,
				name: "Counter-Strike 2",
				playtimeForever: 60,
			},
		]);
		store.claimRunner("runner-one");
		const observedAt = new Date(Date.now() - 30 * 60_000).toISOString();
		store.writeRuntimeSnapshot(account.id, "runner-one", {
			version: 1,
			activity: {
				kind: "boosting",
				appIds: [730],
				customGame: null,
				autoStop: [
					{
						appId: 730,
						observedMinutes: 60,
						targetMinutes: 120,
						observedAt,
						estimatedCompletionAt: new Date(
							Date.parse(observedAt) + 60 * 60_000,
						).toISOString(),
					},
				],
			},
			activitySince: observedAt,
			sessionStartedAt: observedAt,
			externalAppId: null,
		});

		const fleet = buildFleetStatus(store);
		const [status] = fleet.accounts;
		assert.equal(fleet.schemaVersion, 1);
		assert.equal(fleet.runner.state, "running");
		assert.equal(status?.activity.kind, "boosting");
		assert.deepEqual(status?.activity.games, [
			{ appId: 730, name: "Counter-Strike 2" },
		]);
		assert.ok((status?.activity.autoStop[0]?.currentMinutes ?? 0) >= 89);
		assert.ok((status?.sessionUptimeSeconds ?? 0) >= 29 * 60);

		const rendered = formatFleetStatus(fleet, { color: false, width: 100 });
		assert.match(rendered, /LINGER FLEET/u);
		assert.match(rendered, /BOOSTING/u);
		assert.match(rendered, /Counter-Strike 2/u);
		assert.match(rendered, /auto-stop Counter-Strike 2/u);
		const layoutFleet = structuredClone(fleet);
		const layoutAccount = layoutFleet.accounts[0];
		assert.ok(layoutAccount);
		layoutAccount.activity.autoStop = [];
		const lines = formatFleetStatus(layoutFleet, {
			color: false,
			width: 100,
		}).split("\n");
		const activityLine = lines.find((line) => line.includes("BOOSTING"));
		const gameLine = lines.find((line) => line.includes("Counter-Strike 2"));
		const detailLine = lines.find((line) =>
			line.includes("library age unknown"),
		);
		assert.ok(activityLine);
		assert.ok(gameLine);
		assert.ok(detailLine);
		assert.match(activityLine, /BOOSTING\s+1 game/u);
		assert.notEqual(activityLine, gameLine);
		assert.equal(
			activityLine.indexOf("BOOSTING"),
			detailLine.indexOf("session"),
		);
		assert.equal(
			gameLine.indexOf("Counter-Strike 2"),
			detailLine.indexOf("library age unknown"),
		);
		const narrow = formatFleetStatus(layoutFleet, {
			color: false,
			width: 40,
			watch: true,
		});
		assert.match(narrow, /Counter-Strike 2/u);
		for (const line of narrow.split("\n")) {
			assert.ok(line.length <= 40, `Line exceeds terminal width: ${line}`);
		}

		const manyGamesFleet = structuredClone(layoutFleet);
		const manyGamesAccount = manyGamesFleet.accounts[0];
		assert.ok(manyGamesAccount);
		manyGamesAccount.activity.games = Array.from(
			{ length: 14 },
			(_, index) => ({
				appId: index + 1,
				name: `Game ${index + 1}`,
			}),
		);
		const manyGames = formatFleetStatus(manyGamesFleet, {
			color: false,
			width: 80,
			watch: true,
		});
		assert.match(manyGames, /BOOSTING\s+14 games/u);
		assert.match(manyGames, /\+\d+ more \[g\]/u);
		assert.match(manyGames, /g expand games/u);
		assert.equal(
			manyGames.split("\n").filter((line) => /Game \d+/u.test(line)).length,
			1,
		);
		for (const line of manyGames.split("\n")) {
			assert.ok(line.length <= 80, `Line exceeds terminal width: ${line}`);
		}

		const expandedGames = formatFleetStatus(manyGamesFleet, {
			color: false,
			width: 80,
			watch: true,
			expandedGames: true,
		});
		assert.doesNotMatch(expandedGames, /\+\d+ more/u);
		assert.match(expandedGames, /Game 14/u);
		assert.match(expandedGames, /g collapse games/u);
		for (const line of expandedGames.split("\n")) {
			assert.ok(line.length <= 80, `Line exceeds terminal width: ${line}`);
		}
		store.close();
	});

	it("ignores snapshots from a previous runner", () => {
		const store = createStore();
		const account = createAccount(store);
		store.claimRunner("runner-current");
		store.writeRuntimeSnapshot(account.id, "runner-old", {
			version: 1,
			activity: {
				kind: "boosting",
				appIds: [730],
				customGame: null,
				autoStop: [],
			},
			activitySince: new Date().toISOString(),
			sessionStartedAt: new Date().toISOString(),
			externalAppId: null,
		});

		const [status] = buildFleetStatus(store).accounts;
		assert.equal(status?.activity.kind, "idle");
		assert.equal(status?.snapshotRecordedAt, null);
		store.close();
	});

	it("prints a versioned JSON snapshot through the CLI", () => {
		const { databasePath, store } = createDatabase();
		createAccount(store);
		store.close();
		const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
		const result = spawnSync(process.execPath, [cliPath, "status", "--json"], {
			encoding: "utf8",
			env: {
				...process.env,
				LINGER_DB_PATH: databasePath,
				NO_COLOR: "1",
			},
		});

		assert.equal(result.status, 0, result.stderr);
		const parsed = JSON.parse(result.stdout) as {
			schemaVersion: number;
			accounts: Array<{ accountName: string }>;
		};
		assert.equal(parsed.schemaVersion, 1);
		assert.equal(parsed.accounts[0]?.accountName, "vocal");
	});
});

describe("runtime snapshot validation", () => {
	it("rejects malformed persisted timestamps", () => {
		assert.throws(
			() =>
				parseRuntimeSnapshot(
					JSON.stringify({
						version: 1,
						activity: { kind: "retrying", attempt: 1, retryAt: "later" },
						activitySince: new Date().toISOString(),
						sessionStartedAt: null,
						externalAppId: null,
					}),
				),
			/invalid runtime snapshot/iu,
		);
	});
});
