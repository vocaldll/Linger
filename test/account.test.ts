import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MAX_GAMES_PLAYED,
	parseAppIds,
	validateAccountSetup,
	validatePresence,
} from "../src/domain/account.js";
import { filterAccountsForSearch } from "../src/tui.js";

describe("account presence", () => {
	it("parses, validates, and deduplicates AppIDs", () => {
		assert.deepEqual(parseAppIds("730, 440  730\n570"), [730, 440, 570]);
		assert.throws(() => parseAppIds("730, nope"), /Invalid AppID/u);
	});

	it("requires something to idle", () => {
		assert.throws(
			() =>
				validatePresence({
					appIds: [],
					autoStopTargets: [],
					customGame: null,
					visible: true,
					clearRecentActivity: false,
				}),
			/at least one AppID or a custom game name/iu,
		);
	});

	it("allows an empty normal presence while card farming is enabled", () => {
		assert.doesNotThrow(() =>
			validateAccountSetup({
				appIds: [],
				autoStopTargets: [],
				customGame: null,
				visible: false,
				clearRecentActivity: false,
				cardFarmingEnabled: true,
			}),
		);
	});

	it("requires auto-stop targets to belong to selected games", () => {
		assert.doesNotThrow(() =>
			validatePresence({
				appIds: [730],
				autoStopTargets: [{ appId: 730, targetMinutes: 7_777 * 60 }],
				customGame: null,
				visible: true,
				clearRecentActivity: false,
			}),
		);
		assert.throws(
			() =>
				validatePresence({
					appIds: [440],
					autoStopTargets: [{ appId: 730, targetMinutes: 7_777 * 60 }],
					customGame: null,
					visible: true,
					clearRecentActivity: false,
				}),
			/must be a selected game/iu,
		);
	});

	it("enforces Steam's simultaneous presence limit", () => {
		const appIds = Array.from(
			{ length: MAX_GAMES_PLAYED },
			(_, index) => index + 1,
		);
		assert.doesNotThrow(() =>
			validatePresence({
				appIds,
				autoStopTargets: [],
				customGame: null,
				visible: true,
				clearRecentActivity: false,
			}),
		);
		assert.throws(
			() =>
				validatePresence({
					appIds,
					autoStopTargets: [],
					customGame: "Linger",
					visible: true,
					clearRecentActivity: false,
				}),
			/at most 32/iu,
		);
	});

	it("reserves three presence slots when recent-activity clearing is enabled", () => {
		const maximumAppIds = Array.from({ length: 29 }, (_, index) => index + 1);
		assert.doesNotThrow(() =>
			validatePresence({
				appIds: maximumAppIds,
				autoStopTargets: [],
				customGame: null,
				visible: true,
				clearRecentActivity: true,
			}),
		);

		const tooManyAppIds = Array.from({ length: 30 }, (_, index) => index + 1);
		assert.throws(
			() =>
				validatePresence({
					appIds: tooManyAppIds,
					autoStopTargets: [],
					customGame: null,
					visible: true,
					clearRecentActivity: true,
				}),
			/room for at most 29 games/iu,
		);
	});
});

describe("account search", () => {
	const accounts = [
		{
			accountName: "primary",
			steamId: "76561198000000001",
			status: "online" as const,
		},
		{
			accountName: "trading-alt",
			steamId: "76561198000000002",
			status: "needs_auth" as const,
		},
		{
			accountName: "idle-account",
			steamId: null,
			status: "disabled" as const,
		},
	];

	it("filters accounts by name, SteamID, and readable status", () => {
		assert.deepEqual(
			filterAccountsForSearch(accounts, "trading login").map(
				(account) => account.accountName,
			),
			["trading-alt"],
		);
		assert.deepEqual(
			filterAccountsForSearch(accounts, "000000001").map(
				(account) => account.accountName,
			),
			["primary"],
		);
		assert.deepEqual(
			filterAccountsForSearch(accounts, "disabled").map(
				(account) => account.accountName,
			),
			["idle-account"],
		);
		assert.deepEqual(filterAccountsForSearch(accounts, ""), accounts);
	});
});
