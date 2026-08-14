export type OwnedGame = {
	appId: number;
	name: string;
	playtimeForever: number;
};

export type GameSort = "most_played" | "least_played" | "alphabetical";

export const GAME_SORT_LABELS: Record<GameSort, string> = {
	most_played: "Most played",
	least_played: "Least played",
	alphabetical: "A–Z",
};

function compareNames(left: OwnedGame, right: OwnedGame): number {
	return (
		left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
		left.appId - right.appId
	);
}

export function sortOwnedGames(
	games: readonly OwnedGame[],
	sort: GameSort,
): OwnedGame[] {
	return [...games].sort((left, right) => {
		if (sort === "most_played") {
			return (
				right.playtimeForever - left.playtimeForever ||
				compareNames(left, right)
			);
		}
		if (sort === "least_played") {
			return (
				left.playtimeForever - right.playtimeForever ||
				compareNames(left, right)
			);
		}
		return compareNames(left, right);
	});
}

export function filterOwnedGames<Game extends OwnedGame>(
	games: readonly Game[],
	query: string,
): Game[] {
	const normalized = query.trim().toLocaleLowerCase();
	if (!normalized) {
		return [...games];
	}
	return games.filter(
		(game) =>
			game.name.toLocaleLowerCase().includes(normalized) ||
			String(game.appId).includes(normalized),
	);
}

export function formatPlaytime(minutes: number): string {
	if (minutes <= 0) {
		return "Never played";
	}
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = minutes / 60;
	return hours < 10 && !Number.isInteger(hours)
		? `${hours.toFixed(1)}h`
		: `${Math.round(hours)}h`;
}
