import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { render } from "@inquirer/testing";
import type SteamUser from "steam-user";
import {
	filterOwnedGames,
	formatExactPlaytime,
	formatPlaytime,
	type OwnedGame,
	sortOwnedGames,
} from "../src/domain/game-library.js";
import {
	getOwnedGamePlaytimes,
	loadGameLibrary,
	normalizeOwnedGames,
} from "../src/steam/game-library.js";
import { buildPickerEntries, gamePicker } from "../src/tui/game-picker.js";

const GAMES: OwnedGame[] = [
	{ appId: 30, name: "Gamma", playtimeForever: 0 },
	{ appId: 10, name: "alpha", playtimeForever: 600 },
	{ appId: 20, name: "Beta", playtimeForever: 120 },
];

describe("game library", () => {
	it("sorts by most played, least played, and title", () => {
		assert.deepEqual(
			sortOwnedGames(GAMES, "most_played").map((game) => game.appId),
			[10, 20, 30],
		);
		assert.deepEqual(
			sortOwnedGames(GAMES, "least_played").map((game) => game.appId),
			[30, 20, 10],
		);
		assert.deepEqual(
			sortOwnedGames(GAMES, "alphabetical").map((game) => game.appId),
			[10, 20, 30],
		);
	});

	it("searches by game name or AppID", () => {
		assert.deepEqual(
			filterOwnedGames(GAMES, "BET").map((game) => game.appId),
			[20],
		);
		assert.deepEqual(
			filterOwnedGames(GAMES, "30").map((game) => game.appId),
			[30],
		);
	});

	it("pins manually entered AppIDs ahead of the sorted library", () => {
		const entries = buildPickerEntries(GAMES, [999, 20], "most_played");
		assert.equal(entries[0]?.appId, 999);
		assert.equal(entries[0]?.manuallyAdded, true);
		assert.equal(
			entries.find((entry) => entry.appId === 20)?.manuallyAdded,
			false,
		);
	});

	it("shows cached tracked playtime as soon as an AppID is entered", () => {
		const entries = buildPickerEntries(
			GAMES,
			[7],
			"most_played",
			"",
			new Map([[7, 86_040]]),
		);

		assert.equal(entries[0]?.appId, 7);
		assert.equal(entries[0]?.playtimeForever, 86_040);
		assert.equal(entries[0]?.manuallyAdded, true);
		assert.equal(entries[0]?.hasTrackedPlaytime, true);
	});

	it("normalizes Steam data and formats playtime", () => {
		assert.deepEqual(
			normalizeOwnedGames([
				{ appid: 730, name: " Counter-Strike 2 ", playtime_forever: 95 },
				{ appid: 0, name: "Invalid", playtime_forever: 10 },
				{ appid: 440, name: "", playtime_forever: 20 },
			]),
			[{ appId: 730, name: "Counter-Strike 2", playtimeForever: 95 }],
		);
		assert.equal(formatPlaytime(0), "Never played");
		assert.equal(formatPlaytime(30), "30m");
		assert.equal(formatPlaytime(95), "1.6h");
		assert.equal(formatPlaytime(600), "10h");
		assert.match(formatExactPlaytime(466_619), /7\D776h 59m/u);
	});

	it("requests current playtime for only the targeted games", async () => {
		let requestedAppIds: number[] | undefined;
		let includedUnvettedApps = false;
		const client = {
			getUserOwnedApps(
				_steamId: string,
				options: { filterAppids?: number[]; skipUnvettedApps?: boolean },
			) {
				requestedAppIds = options.filterAppids;
				includedUnvettedApps = options.skipUnvettedApps === false;
				return Promise.resolve({
					apps: [
						{ appid: 730, playtime_forever: 466_619 },
						{ appid: 440, playtime_forever: 120 },
					],
				});
			},
		} as unknown as SteamUser;

		const playtimes = await getOwnedGamePlaytimes(
			client,
			"76561198000000000",
			[730, 440],
		);
		assert.deepEqual(requestedAppIds, [730, 440]);
		assert.equal(includedUnvettedApps, true);
		assert.equal(playtimes.get(730), 466_619);
		assert.equal(playtimes.get(440), 120);
	});

	it("loads tracked playtime for a selected app outside the owned-games list", async () => {
		let requestedMethod: string | undefined;
		let ownedAppsOptions:
			| {
					includeFreeSub?: boolean;
					skipUnvettedApps?: boolean;
			  }
			| undefined;
		const client = {
			getUserOwnedApps(
				_steamId: string,
				options: {
					includeFreeSub?: boolean;
					skipUnvettedApps?: boolean;
				},
			) {
				ownedAppsOptions = options;
				return Promise.resolve({
					apps: [
						{ appid: 440, name: "Team Fortress 2", playtime_forever: 120 },
					],
				});
			},
			_send(
				header: { proto: { target_job_name: string } },
				_request: Buffer,
				callback: (
					response: {
						games: Array<{ appid: number; playtime_forever: number }>;
					},
					header: { proto: { eresult: number } },
				) => void,
			) {
				requestedMethod = header.proto.target_job_name;
				callback(
					{
						games: [
							{ appid: 440, playtime_forever: 180 },
							{ appid: 7, playtime_forever: 12_345 },
						],
					},
					{ proto: { eresult: 1 } },
				);
			},
		} as unknown as SteamUser;

		const library = await loadGameLibrary(client, "76561198000000000", [7]);

		assert.equal(requestedMethod, "Player.ClientGetLastPlayedTimes#1");
		assert.equal(ownedAppsOptions?.includeFreeSub, true);
		assert.equal(ownedAppsOptions?.skipUnvettedApps, false);
		assert.equal(library.trackedPlaytimes?.get(7), 12_345);
		assert.deepEqual(library.games, [
			{ appId: 440, name: "Team Fortress 2", playtimeForever: 180 },
			{ appId: 7, name: "AppID 7", playtimeForever: 12_345 },
		]);
	});

	it("uses tracked playtime for hidden auto-stop targets", async () => {
		let requestedOwnedApps = false;
		const client = {
			getUserOwnedApps() {
				requestedOwnedApps = true;
				return Promise.resolve({ apps: [] });
			},
			_send(
				_header: { proto: { target_job_name: string } },
				_request: Buffer,
				callback: (
					response: {
						games: Array<{ appid: number; playtime_forever: number }>;
					},
					header: { proto: { eresult: number } },
				) => void,
			) {
				callback(
					{ games: [{ appid: 7, playtime_forever: 12_345 }] },
					{ proto: { eresult: 1 } },
				);
			},
		} as unknown as SteamUser;

		const playtimes = await getOwnedGamePlaytimes(
			client,
			"76561198000000000",
			[7],
		);

		assert.equal(playtimes.get(7), 12_345);
		assert.equal(requestedOwnedApps, false);
	});

	it("renders most-played first and exposes manual entry without scrolling", async () => {
		const { answer, events, getScreen } = await render(gamePicker, {
			games: GAMES,
			selectedAppIds: [20],
			autoStopTargets: [],
			sort: "most_played",
			maximumSelected: 3,
			allowEmpty: false,
		});

		const screen = getScreen();
		assert.match(screen, /Sort: Most played/u);
		assert.equal(screen.indexOf("alpha") < screen.indexOf("Beta"), true);
		assert.match(screen, /m enter AppIDs/u);
		events.keypress("m");
		assert.deepEqual(await answer, {
			action: "manual",
			selectedAppIds: [20],
			autoStopTargets: [],
			sort: "most_played",
			query: "",
			activeAppId: 10,
		});
	});

	it("renders cached hours for a manually entered AppID", async () => {
		const { answer, events, getScreen } = await render(gamePicker, {
			games: GAMES,
			selectedAppIds: [7],
			autoStopTargets: [],
			sort: "most_played",
			maximumSelected: 3,
			allowEmpty: false,
			trackedPlaytimes: new Map([[7, 86_040]]),
		});

		assert.match(getScreen(), /AppID 7\s+1\D434h · manually added/u);
		events.keypress("escape");
		assert.equal((await answer).action, "cancel");
	});

	it("requests a library refresh while preserving picker state", async () => {
		const { answer, events, getScreen } = await render(gamePicker, {
			games: GAMES,
			selectedAppIds: [20],
			autoStopTargets: [],
			sort: "alphabetical",
			maximumSelected: 3,
			allowEmpty: false,
			allowRefresh: true,
			initialQuery: "bet",
		});

		assert.match(getScreen(), /r refresh library/u);
		events.keypress("r");
		assert.deepEqual(await answer, {
			action: "refresh",
			selectedAppIds: [20],
			autoStopTargets: [],
			sort: "alphabetical",
			query: "bet",
			activeAppId: 20,
		});
	});

	it("opens auto-stop editing for the highlighted selected game", async () => {
		const { answer, events, getScreen } = await render(gamePicker, {
			games: GAMES,
			selectedAppIds: [10],
			autoStopTargets: [{ appId: 10, targetMinutes: 7_777 * 60 }],
			sort: "most_played",
			maximumSelected: 3,
			allowEmpty: false,
		});

		assert.match(getScreen(), /stop at 7\D777h/iu);
		events.keypress("a");
		assert.deepEqual(await answer, {
			action: "autoStop",
			selectedAppIds: [10],
			autoStopTargets: [{ appId: 10, targetMinutes: 7_777 * 60 }],
			sort: "most_played",
			query: "",
			activeAppId: 10,
		});
	});

	it("clears a target when its game is deselected", async () => {
		const { answer, events } = await render(gamePicker, {
			games: GAMES,
			selectedAppIds: [10],
			autoStopTargets: [{ appId: 10, targetMinutes: 7_777 * 60 }],
			sort: "most_played",
			maximumSelected: 3,
			allowEmpty: true,
		});

		events.keypress("space");
		events.keypress("enter");
		const result = await answer;
		assert.deepEqual(result.selectedAppIds, []);
		assert.deepEqual(result.autoStopTargets, []);
	});

	it("searches, toggles a result, and saves the combined selection", async () => {
		const { answer, events, getScreen } = await render(gamePicker, {
			games: GAMES,
			selectedAppIds: [10],
			autoStopTargets: [],
			sort: "most_played",
			maximumSelected: 3,
			allowEmpty: false,
		});

		events.keypress("/");
		events.type("gam");
		assert.match(getScreen(), /Gamma/u);
		assert.doesNotMatch(getScreen(), /Beta/u);
		events.keypress("enter");
		events.keypress("space");
		events.keypress("enter");

		assert.deepEqual(await answer, {
			action: "save",
			selectedAppIds: [10, 30],
			autoStopTargets: [],
			sort: "most_played",
			query: "gam",
			activeAppId: 30,
		});
	});

	it("prevents selecting more games than the current presence limit", async () => {
		const { answer, events, getScreen } = await render(gamePicker, {
			games: GAMES,
			selectedAppIds: [10, 20],
			autoStopTargets: [],
			sort: "most_played",
			maximumSelected: 2,
			allowEmpty: false,
		});

		events.keypress("down");
		events.keypress("down");
		events.keypress("space");
		assert.match(getScreen(), /at most 2 games/u);
		events.keypress("escape");
		assert.equal((await answer).action, "cancel");
	});

	it("stops navigation at the beginning of the library", async () => {
		const { answer, events } = await render(gamePicker, {
			games: GAMES,
			selectedAppIds: [20],
			autoStopTargets: [],
			sort: "most_played",
			maximumSelected: 3,
			allowEmpty: false,
		});

		events.keypress("up");
		events.keypress("m");
		assert.equal((await answer).activeAppId, 10);
	});

	it("returns to the first game after changing sort mode", async () => {
		const firstPicker = await render(gamePicker, {
			games: GAMES,
			selectedAppIds: [20],
			autoStopTargets: [],
			sort: "most_played",
			maximumSelected: 3,
			allowEmpty: false,
		});
		firstPicker.events.keypress("down");
		firstPicker.events.keypress("down");
		firstPicker.events.keypress("s");
		const sortRequest = await firstPicker.answer;
		assert.equal(sortRequest.activeAppId, null);

		const sortedPicker = await render(gamePicker, {
			games: GAMES,
			selectedAppIds: sortRequest.selectedAppIds,
			autoStopTargets: sortRequest.autoStopTargets,
			sort: "least_played",
			maximumSelected: 3,
			allowEmpty: false,
			initialActiveAppId: sortRequest.activeAppId,
		});
		sortedPicker.events.keypress("m");
		assert.equal((await sortedPicker.answer).activeAppId, 30);
	});
});
