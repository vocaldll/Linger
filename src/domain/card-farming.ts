import type { CardFarmingEntry, CardFarmingPolicy } from "./account.js";
import type { OwnedGame } from "./game-library.js";

export const CARD_FARMING_POLICY_LABELS: Record<CardFarmingPolicy, string> = {
	manual: "Manual order",
	fewest_drops: "Fewest drops first",
	least_played: "Least played first",
};

function displayGameDetails(
	appId: number,
	games: ReadonlyMap<number, OwnedGame>,
): OwnedGame {
	return (
		games.get(appId) ?? {
			appId,
			name: `AppID ${appId}`,
			playtimeForever: 0,
		}
	);
}

function compareObservedPlaytime(
	left: OwnedGame | undefined,
	right: OwnedGame | undefined,
): number {
	if (left && right) {
		return left.playtimeForever - right.playtimeForever;
	}
	if (left) {
		return -1;
	}
	if (right) {
		return 1;
	}
	return 0;
}

function compareNames(left: OwnedGame, right: OwnedGame): number {
	return (
		left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
		left.appId - right.appId
	);
}

export function orderCardFarmingQueue(
	entries: readonly CardFarmingEntry[],
	policy: CardFarmingPolicy,
	ownedGames: readonly OwnedGame[],
	preferredOrder: readonly number[] = [],
): CardFarmingEntry[] {
	const games = new Map(ownedGames.map((game) => [game.appId, game]));
	if (policy === "manual") {
		const preferredIndex = new Map(
			preferredOrder.map((appId, index) => [appId, index]),
		);
		return entries
			.map((entry, discoveryIndex) => ({ entry, discoveryIndex }))
			.sort((left, right) => {
				const leftIndex = preferredIndex.get(left.entry.appId);
				const rightIndex = preferredIndex.get(right.entry.appId);
				if (leftIndex !== undefined && rightIndex !== undefined) {
					return leftIndex - rightIndex;
				}
				if (leftIndex !== undefined) {
					return -1;
				}
				if (rightIndex !== undefined) {
					return 1;
				}
				return left.discoveryIndex - right.discoveryIndex;
			})
			.map(({ entry }) => entry);
	}

	return [...entries].sort((left, right) => {
		const leftObserved = games.get(left.appId);
		const rightObserved = games.get(right.appId);
		const leftGame = displayGameDetails(left.appId, games);
		const rightGame = displayGameDetails(right.appId, games);
		const playtimeComparison = compareObservedPlaytime(
			leftObserved,
			rightObserved,
		);
		if (policy === "fewest_drops") {
			return (
				left.remainingDrops - right.remainingDrops ||
				playtimeComparison ||
				compareNames(leftGame, rightGame)
			);
		}
		return (
			playtimeComparison ||
			left.remainingDrops - right.remainingDrops ||
			compareNames(leftGame, rightGame)
		);
	});
}

export function buildCardFarmingQueue(
	discovered: readonly CardFarmingEntry[],
	exclusions: readonly number[],
	policy: CardFarmingPolicy,
	ownedGames: readonly OwnedGame[],
	preferredOrder: readonly number[] = [],
	ignoredAppIds: readonly number[] = [],
): CardFarmingEntry[] {
	const excluded = new Set(exclusions);
	const ignored = new Set(ignoredAppIds);
	return orderCardFarmingQueue(
		discovered.filter(
			(entry) => !excluded.has(entry.appId) && !ignored.has(entry.appId),
		),
		policy,
		ownedGames,
		preferredOrder,
	);
}
