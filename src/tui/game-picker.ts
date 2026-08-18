import {
	createPrompt,
	isBackspaceKey,
	isDownKey,
	isEnterKey,
	isSpaceKey,
	isTabKey,
	isUpKey,
	makeTheme,
	type Status,
	useKeypress,
	usePagination,
	usePrefix,
	useState,
} from "@inquirer/core";
import type { AutoStopTarget } from "../domain/account.js";
import {
	filterOwnedGames,
	formatExactPlaytime,
	GAME_SORT_LABELS,
	type GameSort,
	type OwnedGame,
	sortOwnedGames,
} from "../domain/game-library.js";
import { LINGER_THEME, ui } from "./theme.js";

export type GamePickerResult = {
	action: "save" | "cancel" | "manual" | "refresh" | "sort" | "autoStop";
	selectedAppIds: number[];
	autoStopTargets: AutoStopTarget[];
	sort: GameSort;
	query: string;
	activeAppId: number | null;
};

type GamePickerConfig = {
	games: readonly OwnedGame[];
	selectedAppIds: readonly number[];
	autoStopTargets: readonly AutoStopTarget[];
	sort: GameSort;
	maximumSelected: number;
	allowEmpty: boolean;
	allowRefresh?: boolean;
	initialQuery?: string;
	initialActiveAppId?: number | null;
	trackedPlaytimes?: ReadonlyMap<number, number>;
	notice?: string;
	errorNotice?: string;
	pageSize?: number;
};

type GamePickerContext = {
	input?: NodeJS.ReadableStream;
	output?: NodeJS.WritableStream;
	clearPromptOnDone?: boolean;
	signal?: AbortSignal;
};

type PickerEntry = OwnedGame & {
	manuallyAdded: boolean;
	hasTrackedPlaytime: boolean;
};

export function buildPickerEntries(
	games: readonly OwnedGame[],
	selectedAppIds: readonly number[],
	sort: GameSort,
	query = "",
	trackedPlaytimes: ReadonlyMap<number, number> = new Map(),
): PickerEntry[] {
	const ownedIds = new Set(games.map((game) => game.appId));
	const manuallyAdded = selectedAppIds
		.filter((appId) => !ownedIds.has(appId))
		.map((appId) => {
			const playtimeForever = trackedPlaytimes.get(appId);
			return {
				appId,
				name: `AppID ${appId}`,
				playtimeForever: playtimeForever ?? 0,
				manuallyAdded: true,
				hasTrackedPlaytime: playtimeForever !== undefined,
			};
		});
	const owned = sortOwnedGames(games, sort).map((game) => ({
		...game,
		manuallyAdded: false,
		hasTrackedPlaytime: true,
	}));
	return filterOwnedGames([...manuallyAdded, ...owned], query);
}

function truncate(value: string, maximumLength: number): string {
	return value.length <= maximumLength
		? value
		: `${value.slice(0, maximumLength - 1)}…`;
}

export const gamePicker: (
	config: GamePickerConfig,
	context?: GamePickerContext,
) => Promise<GamePickerResult> = createPrompt<
	GamePickerResult,
	GamePickerConfig
>((config, done) => {
	const [status, setStatus] = useState<Status>("idle");
	const [selectedAppIds, setSelectedAppIds] = useState([
		...config.selectedAppIds,
	]);
	const [autoStopTargets, setAutoStopTargets] = useState([
		...config.autoStopTargets,
	]);
	const [query, setQuery] = useState(config.initialQuery ?? "");
	const [searching, setSearching] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const entries = buildPickerEntries(
		config.games,
		selectedAppIds,
		config.sort,
		query,
		config.trackedPlaytimes,
	);
	const initialActive = Math.max(
		0,
		entries.findIndex((game) => game.appId === config.initialActiveAppId),
	);
	const [active, setActive] = useState(initialActive);
	const activeIndex = Math.min(active, Math.max(0, entries.length - 1));
	const prefix = usePrefix({ status, theme: makeTheme(LINGER_THEME) });

	const complete = (action: GamePickerResult["action"]): void => {
		const result: GamePickerResult = {
			action,
			selectedAppIds,
			autoStopTargets,
			sort: config.sort,
			query,
			activeAppId:
				action === "sort" ? null : (entries[activeIndex]?.appId ?? null),
		};
		setStatus("done");
		done(result);
	};

	useKeypress((key) => {
		const pressed = key as typeof key & { meta?: boolean; sequence?: string };
		if (searching) {
			if (key.name === "escape") {
				setQuery("");
				setSearching(false);
				setActive(0);
			} else if (isTabKey(key) || isEnterKey(key)) {
				setSearching(false);
			} else if (isBackspaceKey(key)) {
				setQuery(query.slice(0, -1));
				setActive(0);
			} else if (
				!key.ctrl &&
				!pressed.meta &&
				pressed.sequence &&
				[...pressed.sequence].length === 1
			) {
				setQuery(`${query}${pressed.sequence}`);
				setActive(0);
			}
			return;
		}

		if (isUpKey(key) && entries.length > 0) {
			setError(null);
			setActive(Math.max(0, activeIndex - 1));
		} else if (isDownKey(key) && entries.length > 0) {
			setError(null);
			setActive(Math.min(entries.length - 1, activeIndex + 1));
		} else if (isSpaceKey(key) && entries.length > 0) {
			const entry = entries[activeIndex];
			if (entry === undefined) {
				return;
			}
			const appId = entry.appId;
			if (selectedAppIds.includes(appId)) {
				setSelectedAppIds(
					selectedAppIds.filter((selected) => selected !== appId),
				);
				setAutoStopTargets(
					autoStopTargets.filter((target) => target.appId !== appId),
				);
				setError(null);
			} else if (selectedAppIds.length >= config.maximumSelected) {
				setError(
					`You can select at most ${config.maximumSelected} games with the current settings`,
				);
			} else {
				setSelectedAppIds([...selectedAppIds, appId]);
				setError(null);
			}
		} else if (key.name === "a" && entries.length > 0) {
			const appId = entries[activeIndex]?.appId;
			if (appId !== undefined && selectedAppIds.includes(appId)) {
				complete("autoStop");
			} else {
				setError("Select the game before setting an auto-stop target");
			}
		} else if (pressed.sequence === "/" || key.name === "/") {
			setSearching(true);
			setError(null);
		} else if (key.name === "s") {
			complete("sort");
		} else if (key.name === "m") {
			complete("manual");
		} else if (key.name === "r" && config.allowRefresh) {
			complete("refresh");
		} else if (key.name === "escape") {
			if (query) {
				setQuery("");
				setActive(0);
			} else {
				complete("cancel");
			}
		} else if (isEnterKey(key)) {
			if (!config.allowEmpty && selectedAppIds.length === 0) {
				setError("Select at least one game or add an AppID manually");
			} else {
				complete("save");
			}
		}
	});

	const nameWidth = Math.max(
		16,
		Math.min(42, (process.stdout.columns || 80) - 34),
	);
	const paginatedEntries = usePagination({
		items: entries,
		active: activeIndex,
		pageSize: config.pageSize ?? 10,
		loop: false,
		renderItem({ item, isActive }) {
			const checked = selectedAppIds.includes(item.appId);
			const autoStop = autoStopTargets.find(
				(target) => target.appId === item.appId,
			);
			const cursor = isActive ? ui.accentStrong("›") : " ";
			const checkbox = checked ? ui.success("[●]") : ui.muted("[ ]");
			const name = truncate(item.name, nameWidth).padEnd(nameWidth);
			const playtimeDetail = item.manuallyAdded
				? item.hasTrackedPlaytime
					? `${formatExactPlaytime(item.playtimeForever)} · manually added`
					: "manually added"
				: `${formatExactPlaytime(item.playtimeForever)} · AppID ${item.appId}`;
			const targetDetail = autoStop
				? `stop at ${Math.floor(autoStop.targetMinutes / 60).toLocaleString()}h`
				: null;
			const detail = targetDetail
				? `${playtimeDetail} · ${targetDetail}`
				: playtimeDetail;
			const row = `${cursor} ${checkbox} ${name} ${ui.muted(detail)}`;
			return isActive ? ui.accentStrong(row) : row;
		},
	});
	const page =
		entries.length === 0
			? ui.muted(
					query
						? "  No games match this search."
						: "  No library games available.",
				)
			: paginatedEntries;

	if (status === "done") {
		return `${prefix} Choose boosted games ${ui.accent(`${selectedAppIds.length} selected`)}`;
	}

	const count = `${selectedAppIds.length} / ${config.maximumSelected}`;
	const searchLine = searching
		? `${ui.strong("Search:")} ${query}${ui.accentStrong("_")}`
		: query
			? `${ui.strong("Filter:")} ${ui.accent(query)}`
			: null;
	const help = searching
		? `${ui.key("type")} ${ui.muted("search")} · ${ui.key("enter/tab")} ${ui.muted("browse")} · ${ui.key("esc")} ${ui.muted("clear")}`
		: [
				`${ui.key("↑↓")} ${ui.muted("move")}`,
				`${ui.key("space")} ${ui.muted("toggle")}`,
				`${ui.key("/")} ${ui.muted("search")}`,
				`${ui.key("s")} ${ui.muted("sort")}`,
				...(config.allowRefresh
					? [`${ui.key("r")} ${ui.muted("refresh library")}`]
					: []),
				`${ui.key("m")} ${ui.muted("enter AppIDs")}`,
				`${ui.key("a")} ${ui.muted("auto-stop")}`,
				`${ui.key("enter")} ${ui.muted("save")}`,
				`${ui.key("esc")} ${ui.muted("clear/cancel")}`,
			].join(ui.muted(" · "));

	return [
		`${prefix} ${ui.strong("Choose boosted games")} ${ui.accentStrong(count)}`,
		`${ui.muted("Sort:")} ${GAME_SORT_LABELS[config.sort]}`,
		searchLine,
		"",
		page,
		"",
		config.notice ? ui.success(`✓ ${config.notice}`) : null,
		config.errorNotice ? ui.danger(`! ${config.errorNotice}`) : null,
		error ? ui.danger(`! ${error}`) : null,
		help,
	]
		.filter((line): line is string => line !== null)
		.join("\n")
		.trimEnd();
});
