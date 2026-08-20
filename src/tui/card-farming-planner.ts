import {
	createPrompt,
	isDownKey,
	isEnterKey,
	isSpaceKey,
	isUpKey,
	makeTheme,
	type Status,
	useKeypress,
	usePagination,
	usePrefix,
	useState,
} from "@inquirer/core";
import type { CardFarmingEntry, CardFarmingPolicy } from "../domain/account.js";
import {
	CARD_FARMING_POLICY_LABELS,
	orderCardFarmingQueue,
} from "../domain/card-farming.js";
import { formatExactPlaytime, type OwnedGame } from "../domain/game-library.js";
import { LINGER_THEME, ui } from "./theme.js";

export type CardFarmingPlannerResult = {
	action: "save" | "cancel" | "rescan";
	queue: CardFarmingEntry[];
	policy: CardFarmingPolicy;
	rescanAfterCompletion: boolean;
};

type CardFarmingPlannerConfig = {
	discovered: readonly CardFarmingEntry[];
	ownedGames: readonly OwnedGame[];
	initialQueue: readonly CardFarmingEntry[];
	initialPolicy: CardFarmingPolicy;
	initialRescanAfterCompletion: boolean;
	submitLabel?: "start" | "save queue";
	pageSize?: number;
};

type CardFarmingPlannerContext = {
	input?: NodeJS.ReadableStream;
	output?: NodeJS.WritableStream;
	clearPromptOnDone?: boolean;
	signal?: AbortSignal;
};

export type CardFarmingPlannerEntry = OwnedGame & {
	hasCachedPlaytime: boolean;
	remainingDrops: number | null;
};

function truncate(value: string, maximumLength: number): string {
	return value.length <= maximumLength
		? value
		: `${value.slice(0, maximumLength - 1)}…`;
}

export function buildCardFarmingPlannerEntries(
	discovered: readonly CardFarmingEntry[],
	ownedGames: readonly OwnedGame[],
	queue: readonly CardFarmingEntry[],
	showEntireLibrary: boolean,
): CardFarmingPlannerEntry[] {
	const discoveredByAppId = new Map(
		discovered.map((entry) => [entry.appId, entry.remainingDrops]),
	);
	const ownedByAppId = new Map(ownedGames.map((game) => [game.appId, game]));
	const details = (appId: number): CardFarmingPlannerEntry => {
		const owned = ownedByAppId.get(appId);
		return {
			appId,
			name: owned?.name ?? `AppID ${appId}`,
			playtimeForever: owned?.playtimeForever ?? 0,
			hasCachedPlaytime: owned !== undefined,
			remainingDrops: discoveredByAppId.get(appId) ?? null,
		};
	};
	const selected = queue.map((entry) => details(entry.appId));
	const selectedIds = new Set(queue.map((entry) => entry.appId));
	const available = discovered
		.filter((entry) => !selectedIds.has(entry.appId))
		.map((entry) => details(entry.appId));
	if (!showEntireLibrary) {
		return [...selected, ...available];
	}
	const discoveredIds = new Set(discovered.map((entry) => entry.appId));
	const unavailable = ownedGames
		.filter((game) => !discoveredIds.has(game.appId))
		.map((game) => ({
			...game,
			hasCachedPlaytime: true,
			remainingDrops: null,
		}))
		.sort(
			(left, right) =>
				left.name.localeCompare(right.name, undefined, {
					sensitivity: "base",
				}) || left.appId - right.appId,
		);
	return [...selected, ...available, ...unavailable];
}

export function applyQueueOrderToDisplay(
	displayOrder: readonly number[],
	queue: readonly CardFarmingEntry[],
): number[] {
	const queuedAppIds = new Set(queue.map((entry) => entry.appId));
	let queueIndex = 0;
	return displayOrder.map((appId) => {
		if (!queuedAppIds.has(appId)) {
			return appId;
		}
		const queuedAppId = queue[queueIndex]?.appId;
		queueIndex += 1;
		return queuedAppId ?? appId;
	});
}

const POLICY_ORDER: readonly CardFarmingPolicy[] = [
	"manual",
	"fewest_drops",
	"least_played",
];

export const cardFarmingPlanner: (
	config: CardFarmingPlannerConfig,
	context?: CardFarmingPlannerContext,
) => Promise<CardFarmingPlannerResult> = createPrompt<
	CardFarmingPlannerResult,
	CardFarmingPlannerConfig
>((config, done) => {
	const [status, setStatus] = useState<Status>("idle");
	const [queue, setQueue] = useState([...config.initialQueue]);
	const [policy, setPolicy] = useState(config.initialPolicy);
	const [rescanAfterCompletion, setRescanAfterCompletion] = useState(
		config.initialRescanAfterCompletion,
	);
	const [showEntireLibrary, setShowEntireLibrary] = useState(false);
	const [active, setActive] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [displayOrder, setDisplayOrder] = useState(
		buildCardFarmingPlannerEntries(
			config.discovered,
			config.ownedGames,
			config.initialQueue,
			false,
		).map((entry) => entry.appId),
	);
	const allEntries = buildCardFarmingPlannerEntries(
		config.discovered,
		config.ownedGames,
		queue,
		true,
	);
	const entriesByAppId = new Map(
		allEntries.map((entry) => [entry.appId, entry]),
	);
	const unavailableAppIds = allEntries
		.filter((entry) => entry.remainingDrops === null)
		.map((entry) => entry.appId);
	const displayedAppIds = showEntireLibrary
		? [...displayOrder, ...unavailableAppIds]
		: displayOrder;
	const entries = displayedAppIds.flatMap((appId) => {
		const entry = entriesByAppId.get(appId);
		return entry ? [entry] : [];
	});
	const activeIndex = Math.max(
		0,
		Math.min(active, Math.max(0, entries.length - 1)),
	);
	const prefix = usePrefix({ status, theme: makeTheme(LINGER_THEME) });

	const complete = (action: CardFarmingPlannerResult["action"]): void => {
		setStatus("done");
		done({ action, queue, policy, rescanAfterCompletion });
	};

	useKeypress((key) => {
		const pressed = key as typeof key & { sequence?: string };
		const symbol = pressed.sequence ?? key.name;
		if (isUpKey(key) && entries.length > 0) {
			setActive(Math.max(0, activeIndex - 1));
			setError(null);
		} else if (isDownKey(key) && entries.length > 0) {
			setActive(Math.min(entries.length - 1, activeIndex + 1));
			setError(null);
		} else if (isSpaceKey(key) && entries.length > 0) {
			const entry = entries[activeIndex];
			if (!entry) {
				return;
			}
			if (entry.remainingDrops === null) {
				setError(
					"Steam did not report remaining card drops for this game in the latest scan",
				);
				return;
			}
			const queueIndex = queue.findIndex(
				(candidate) => candidate.appId === entry.appId,
			);
			if (queueIndex >= 0) {
				setQueue(queue.filter((candidate) => candidate.appId !== entry.appId));
			} else {
				const addedQueue = [
					...queue,
					{ appId: entry.appId, remainingDrops: entry.remainingDrops },
				];
				const nextQueue =
					policy === "manual"
						? displayOrder.flatMap((appId) => {
								const candidate = addedQueue.find(
									(queueEntry) => queueEntry.appId === appId,
								);
								return candidate ? [candidate] : [];
							})
						: orderCardFarmingQueue(
								addedQueue,
								policy,
								config.ownedGames,
								queue.map((candidate) => candidate.appId),
							);
				setQueue(nextQueue);
			}
			setError(null);
		} else if ((symbol === "[" || symbol === "]") && entries.length > 0) {
			const appId = entries[activeIndex]?.appId;
			if (appId === undefined) {
				return;
			}
			const queueIndex = queue.findIndex((entry) => entry.appId === appId);
			if (queueIndex < 0) {
				setError("Include the game before changing its queue position");
				return;
			}
			const direction = symbol === "[" ? -1 : 1;
			const target = queueIndex + direction;
			if (target < 0 || target >= queue.length) {
				setError(
					direction < 0
						? "This game is already first"
						: "This game is already last",
				);
				return;
			}
			const reordered = [...queue];
			[reordered[queueIndex], reordered[target]] = [
				reordered[target] as CardFarmingEntry,
				reordered[queueIndex] as CardFarmingEntry,
			];
			const nextDisplayOrder = applyQueueOrderToDisplay(
				displayOrder,
				reordered,
			);
			setQueue(reordered);
			setDisplayOrder(nextDisplayOrder);
			setPolicy("manual");
			setActive(nextDisplayOrder.indexOf(appId));
			setError(null);
		} else if (key.name === "p") {
			const nextPolicy =
				POLICY_ORDER[
					(POLICY_ORDER.indexOf(policy) + 1) % POLICY_ORDER.length
				] ?? "manual";
			setPolicy(nextPolicy);
			const nextQueue = orderCardFarmingQueue(
				queue,
				nextPolicy,
				config.ownedGames,
				queue.map((entry) => entry.appId),
			);
			const activeAppId = entries[activeIndex]?.appId;
			const nextDisplayOrder = applyQueueOrderToDisplay(
				displayOrder,
				nextQueue,
			);
			setQueue(nextQueue);
			setDisplayOrder(nextDisplayOrder);
			const nextDisplayedAppIds = showEntireLibrary
				? [...nextDisplayOrder, ...unavailableAppIds]
				: nextDisplayOrder;
			setActive(
				activeAppId === undefined
					? 0
					: nextDisplayedAppIds.indexOf(activeAppId),
			);
			setError(null);
		} else if (key.name === "t") {
			setRescanAfterCompletion(!rescanAfterCompletion);
			setError(null);
		} else if (key.name === "v") {
			setShowEntireLibrary(!showEntireLibrary);
			setActive(0);
			setError(null);
		} else if (key.name === "r") {
			complete("rescan");
		} else if (key.name === "escape") {
			complete("cancel");
		} else if (isEnterKey(key)) {
			if (queue.length === 0) {
				setError("Include at least one farmable game before starting");
			} else {
				complete("save");
			}
		}
	});

	const queueIndex = new Map(queue.map((entry, index) => [entry.appId, index]));
	const nameWidth = Math.max(
		12,
		Math.min(40, (process.stdout.columns || 80) - 50),
	);
	const paginatedEntries = usePagination({
		items: entries,
		active: activeIndex,
		pageSize: config.pageSize ?? 10,
		loop: false,
		renderItem({ item, isActive }) {
			const position = queueIndex.get(item.appId);
			const cursor = isActive ? ui.accentStrong("›") : " ";
			const marker =
				position === undefined
					? ui.muted("[ ]")
					: ui.success(`[${String(position + 1).padStart(2, "0")}]`);
			const name = truncate(item.name, nameWidth).padEnd(nameWidth);
			const playtime = item.hasCachedPlaytime
				? `${item.playtimeForever === 0 ? "0m" : formatExactPlaytime(item.playtimeForever)} cached`
				: "playtime unavailable";
			const reason =
				item.remainingDrops === null
					? "not farmable · no drops reported"
					: `${item.remainingDrops} drop${item.remainingDrops === 1 ? "" : "s"} · ${position === undefined ? "excluded" : "queued"}`;
			const row = `${cursor} ${marker} ${name} ${ui.muted(`${reason} · ${playtime}`)}`;
			return isActive ? ui.accentStrong(row) : row;
		},
	});
	const page =
		entries.length === 0
			? ui.muted("  Steam did not report any games with remaining card drops.")
			: paginatedEntries;

	if (status === "done") {
		return `${prefix} Plan card farming ${ui.accent(`${queue.length} queued`)}`;
	}

	const totalDrops = queue.reduce(
		(total, entry) => total + entry.remainingDrops,
		0,
	);
	const help = [
		`${ui.key("↑↓")} ${ui.muted("move")}`,
		`${ui.key("space")} ${ui.muted("include/exclude")}`,
		`${ui.key("[ ]")} ${ui.muted("reorder")}`,
		`${ui.key("p")} ${ui.muted("policy")}`,
		`${ui.key("t")} ${ui.muted("rescan toggle")}`,
		`${ui.key("v")} ${ui.muted(showEntireLibrary ? "farmable only" : "explain library")}`,
		`${ui.key("r")} ${ui.muted("scan again")}`,
		`${ui.key("enter")} ${ui.muted(config.submitLabel ?? "start")}`,
		`${ui.key("esc")} ${ui.muted("cancel")}`,
	].join(ui.muted(" · "));

	return [
		`${prefix} ${ui.strong("Plan card farming")} ${ui.accentStrong(`${queue.length} games · ${totalDrops} drops`)}`,
		`${ui.muted("Order:")} ${CARD_FARMING_POLICY_LABELS[policy]} ${ui.muted("· Rescan after each game:")} ${rescanAfterCompletion ? ui.success("on") : ui.muted("off")}`,
		ui.muted(
			showEntireLibrary
				? "Games without a reported drop count cannot be queued."
				: "Only games with remaining drops from the latest Steam scan are shown.",
		),
		"",
		page,
		"",
		error ? ui.danger(`! ${error}`) : null,
		help,
	]
		.filter((line): line is string => line !== null)
		.join("\n")
		.trimEnd();
});
