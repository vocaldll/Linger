import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { render } from "@inquirer/testing";
import {
	buildCardFarmingQueue,
	orderCardFarmingQueue,
} from "../src/domain/card-farming.js";
import type { OwnedGame } from "../src/domain/game-library.js";
import {
	applyQueueOrderToDisplay,
	buildCardFarmingPlannerEntries,
	cardFarmingPlanner,
} from "../src/tui/card-farming-planner.js";

const GAMES: OwnedGame[] = [
	{ appId: 10, name: "Long played", playtimeForever: 600 },
	{ appId: 20, name: "Fresh", playtimeForever: 0 },
	{ appId: 30, name: "No drops", playtimeForever: 120 },
];

const DISCOVERED = [
	{ appId: 10, remainingDrops: 3 },
	{ appId: 20, remainingDrops: 1 },
];

describe("card-farming planner", () => {
	it("orders queues by drop count, playtime, or a preferred manual order", () => {
		assert.deepEqual(
			orderCardFarmingQueue(DISCOVERED, "fewest_drops", GAMES).map(
				(entry) => entry.appId,
			),
			[20, 10],
		);
		assert.deepEqual(
			orderCardFarmingQueue(DISCOVERED, "least_played", GAMES).map(
				(entry) => entry.appId,
			),
			[20, 10],
		);
		assert.deepEqual(
			orderCardFarmingQueue(DISCOVERED, "manual", GAMES, [20, 10]).map(
				(entry) => entry.appId,
			),
			[20, 10],
		);
		assert.deepEqual(
			orderCardFarmingQueue(
				[...DISCOVERED, { appId: 40, remainingDrops: 1 }],
				"least_played",
				GAMES,
			).map((entry) => entry.appId),
			[20, 10, 40],
		);
	});

	it("filters exclusions before applying a policy", () => {
		assert.deepEqual(
			buildCardFarmingQueue(DISCOVERED, [20], "fewest_drops", GAMES),
			[{ appId: 10, remainingDrops: 3 }],
		);
	});

	it("puts the reviewed queue first and explains unavailable library games", () => {
		const entries = buildCardFarmingPlannerEntries(
			DISCOVERED,
			GAMES,
			[{ appId: 20, remainingDrops: 1 }],
			true,
		);
		assert.deepEqual(
			entries.map((entry) => [entry.appId, entry.remainingDrops]),
			[
				[20, 1],
				[10, 3],
				[30, null],
			],
		);
	});

	it("reorders queued rows without moving excluded rows", () => {
		assert.deepEqual(
			applyQueueOrderToDisplay(
				[10, 30, 20],
				[
					{ appId: 20, remainingDrops: 1 },
					{ appId: 10, remainingDrops: 3 },
				],
			),
			[20, 30, 10],
		);
	});

	it("renders drops and cached playtime and applies queue policies", async () => {
		const { answer, events, getScreen } = await render(cardFarmingPlanner, {
			discovered: DISCOVERED,
			ownedGames: GAMES,
			initialQueue: DISCOVERED,
			initialPolicy: "manual",
			initialRescanAfterCompletion: false,
		});

		assert.match(getScreen(), /3 drops · queued · 10h cached/u);
		assert.match(getScreen(), /Manual order/u);
		events.keypress("p");
		assert.match(getScreen(), /Fewest drops first/u);
		events.keypress("enter");
		const result = await answer;
		assert.equal(result.action, "save");
		assert.deepEqual(
			result.queue.map((entry) => entry.appId),
			[20, 10],
		);
	});

	it("does not present missing playtime as an observed zero", async () => {
		const unknown = { appId: 40, remainingDrops: 2 };
		const { answer, events, getScreen } = await render(cardFarmingPlanner, {
			discovered: [unknown],
			ownedGames: GAMES,
			initialQueue: [unknown],
			initialPolicy: "manual",
			initialRescanAfterCompletion: false,
			submitLabel: "save queue",
		});

		assert.match(
			getScreen(),
			/AppID 40\s+2 drops · queued · playtime unavailable/u,
		);
		assert.match(getScreen(), /enter save queue/u);
		events.keypress("escape");
		assert.equal((await answer).action, "cancel");
	});

	it("supports manual reordering and requesting another scan", async () => {
		const { answer, events } = await render(cardFarmingPlanner, {
			discovered: DISCOVERED,
			ownedGames: GAMES,
			initialQueue: DISCOVERED,
			initialPolicy: "fewest_drops",
			initialRescanAfterCompletion: false,
		});

		events.keypress("]");
		events.keypress("t");
		events.keypress("r");
		const result = await answer;
		assert.equal(result.action, "rescan");
		assert.equal(result.policy, "manual");
		assert.equal(result.rescanAfterCompletion, true);
		assert.deepEqual(
			result.queue.map((entry) => entry.appId),
			[20, 10],
		);
	});

	it("keeps an excluded game under the cursor and restores its position", async () => {
		const { answer, events, getScreen } = await render(cardFarmingPlanner, {
			discovered: DISCOVERED,
			ownedGames: GAMES,
			initialQueue: DISCOVERED,
			initialPolicy: "manual",
			initialRescanAfterCompletion: false,
		});

		events.keypress("space");
		const excludedScreen = getScreen();
		assert.match(excludedScreen, /› \[ \] Long played\s+3 drops · excluded/u);
		assert.equal(
			excludedScreen.indexOf("Long played") < excludedScreen.indexOf("Fresh"),
			true,
		);

		events.keypress("space");
		assert.match(getScreen(), /› \[01\] Long played\s+3 drops · queued/u);
		events.keypress("enter");
		assert.deepEqual(
			(await answer).queue.map((entry) => entry.appId),
			[10, 20],
		);
	});

	it("shows why unreported library games cannot be queued", async () => {
		const { answer, events, getScreen } = await render(cardFarmingPlanner, {
			discovered: DISCOVERED,
			ownedGames: GAMES,
			initialQueue: DISCOVERED,
			initialPolicy: "manual",
			initialRescanAfterCompletion: false,
		});

		events.keypress("v");
		assert.match(getScreen(), /No drops\s+not farmable · no drops reported/u);
		events.keypress("down");
		events.keypress("down");
		events.keypress("p");
		assert.match(
			getScreen(),
			/› \[ \] No drops\s+not farmable · no drops reported/u,
		);
		events.keypress("escape");
		assert.equal((await answer).action, "cancel");
	});
});
