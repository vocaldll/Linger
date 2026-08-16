import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { render } from "@inquirer/testing";
import {
	filterOwnedGames,
	formatPlaytime,
	type OwnedGame,
	sortOwnedGames,
} from "../src/domain/game-library.js";
import { normalizeOwnedGames } from "../src/steam/game-library.js";
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
	});

	it("renders most-played first and exposes manual entry without scrolling", async () => {
		const { answer, events, getScreen } = await render(gamePicker, {
			games: GAMES,
			selectedAppIds: [20],
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
			sort: "most_played",
			query: "",
			activeAppId: 10,
		});
	});

	it("requests a library refresh while preserving picker state", async () => {
		const { answer, events, getScreen } = await render(gamePicker, {
			games: GAMES,
			selectedAppIds: [20],
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
			sort: "alphabetical",
			query: "bet",
			activeAppId: 20,
		});
	});

	it("searches, toggles a result, and saves the combined selection", async () => {
		const { answer, events, getScreen } = await render(gamePicker, {
			games: GAMES,
			selectedAppIds: [10],
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
			sort: "most_played",
			query: "gam",
			activeAppId: 30,
		});
	});

	it("prevents selecting more games than the current presence limit", async () => {
		const { answer, events, getScreen } = await render(gamePicker, {
			games: GAMES,
			selectedAppIds: [10, 20],
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
			sort: "least_played",
			maximumSelected: 3,
			allowEmpty: false,
			initialActiveAppId: sortRequest.activeAppId,
		});
		sortedPicker.events.keypress("m");
		assert.equal((await sortedPicker.answer).activeAppId, 30);
	});
});
