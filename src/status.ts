import type { ReadStream, WriteStream } from "node:tty";
import { styleText } from "node:util";
import type { AccountStore, LibraryRefreshState } from "./database.js";
import type { Account, AccountStatus } from "./domain/account.js";
import type {
	RuntimeActivity,
	StoredRuntimeSnapshot,
} from "./domain/runtime-snapshot.js";
import { PALETTE } from "./theme.js";

export type StatusGame = {
	appId: number;
	name: string | null;
};

export type StatusAutoStop = StatusGame & {
	currentMinutes: number;
	targetMinutes: number;
	progress: number;
	estimatedCompletionAt: string;
};

export type StatusActivity = {
	kind: RuntimeActivity["kind"];
	since: string | null;
	games: StatusGame[];
	customGame: string | null;
	attempt: number | null;
	retryAt: string | null;
	remainingDrops: number | null;
	queuePosition: number | null;
	queueLength: number | null;
	nextCheckAt: string | null;
	externalGame: StatusGame | null;
	autoStop: StatusAutoStop[];
};

export type AccountFleetStatus = {
	id: string;
	accountName: string;
	steamId: string | null;
	status: AccountStatus;
	activity: StatusActivity;
	sessionStartedAt: string | null;
	sessionUptimeSeconds: number | null;
	lastConnectedAt: string | null;
	lastError: string | null;
	library: {
		cachedGames: number;
		lastSuccessAt: string | null;
		ageSeconds: number | null;
		lastAttemptAt: string | null;
		lastError: string | null;
	};
	snapshotRecordedAt: string | null;
};

export type FleetStatus = {
	schemaVersion: 1;
	generatedAt: string;
	runner: {
		state: "running" | "stopped";
		heartbeatAt: string | null;
	};
	accounts: AccountFleetStatus[];
};

type StatusFormatOptions = {
	color: boolean;
	width?: number;
	watch?: boolean;
};

function secondsSince(timestamp: string, now: number): number {
	return Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1_000));
}

function gameReference(
	appId: number,
	names: ReadonlyMap<number, string>,
): StatusGame {
	return { appId, name: names.get(appId) ?? null };
}

function fallbackActivity(
	account: Account,
	runnerRunning: boolean,
): RuntimeActivity {
	if (
		!runnerRunning &&
		account.status !== "disabled" &&
		account.status !== "needs_auth" &&
		account.status !== "error"
	) {
		return { kind: "idle" };
	}
	switch (account.status) {
		case "disabled":
			return { kind: "disabled" };
		case "connecting":
			return { kind: "connecting", attempt: 1 };
		case "backoff":
			return {
				kind: "retrying",
				attempt: 1,
				retryAt: new Date(0).toISOString(),
			};
		case "needs_auth":
			return { kind: "needs_auth" };
		case "error":
			return { kind: "error" };
		default:
			return { kind: "idle" };
	}
}

function buildActivity(
	account: Account,
	stored: StoredRuntimeSnapshot | null,
	names: ReadonlyMap<number, string>,
	now: number,
	runnerRunning: boolean,
): StatusActivity {
	const activity =
		stored?.snapshot.activity ?? fallbackActivity(account, runnerRunning);
	const result: StatusActivity = {
		kind: activity.kind,
		since: stored?.snapshot.activitySince ?? null,
		games: [],
		customGame: null,
		attempt: null,
		retryAt: null,
		remainingDrops: null,
		queuePosition: null,
		queueLength: null,
		nextCheckAt: null,
		externalGame: null,
		autoStop: [],
	};

	if (activity.kind === "connecting") {
		result.attempt = activity.attempt;
	} else if (activity.kind === "retrying") {
		result.attempt = activity.attempt;
		result.retryAt = Date.parse(activity.retryAt) > 0 ? activity.retryAt : null;
	} else if (activity.kind === "boosting") {
		result.games = activity.appIds.map((appId) => gameReference(appId, names));
		result.customGame = activity.customGame;
		result.autoStop = activity.autoStop.map((progress) => {
			const elapsedMinutes = Math.max(
				0,
				(now - Date.parse(progress.observedAt)) / 60_000,
			);
			const currentMinutes = Math.min(
				progress.targetMinutes,
				progress.observedMinutes + elapsedMinutes,
			);
			return {
				...gameReference(progress.appId, names),
				currentMinutes,
				targetMinutes: progress.targetMinutes,
				progress: Math.min(1, currentMinutes / progress.targetMinutes),
				estimatedCompletionAt: progress.estimatedCompletionAt,
			};
		});
	} else if (activity.kind === "farming") {
		result.games =
			activity.appId === null ? [] : [gameReference(activity.appId, names)];
		result.remainingDrops = activity.remainingDrops;
		result.queuePosition = activity.appId === null ? null : 1;
		result.queueLength = activity.queueLength;
		result.nextCheckAt = activity.nextCheckAt;
	} else if (activity.kind === "waiting_external_game") {
		result.externalGame =
			activity.externalAppId === null
				? null
				: gameReference(activity.externalAppId, names);
		result.nextCheckAt = activity.nextCheckAt;
	}
	return result;
}

function libraryStatus(
	refresh: LibraryRefreshState,
	cachedGames: number,
	now: number,
): AccountFleetStatus["library"] {
	return {
		cachedGames,
		lastSuccessAt: refresh.lastSuccessAt,
		ageSeconds:
			refresh.lastSuccessAt === null
				? null
				: secondsSince(refresh.lastSuccessAt, now),
		lastAttemptAt: refresh.lastAttemptAt,
		lastError: refresh.lastError,
	};
}

export function buildFleetStatus(
	store: AccountStore,
	now = Date.now(),
): FleetStatus {
	const lease = store.getActiveRunnerLease();
	const snapshots = new Map(
		(lease ? store.listRuntimeSnapshots(lease.ownerId) : []).map((snapshot) => [
			snapshot.accountId,
			snapshot,
		]),
	);
	return {
		schemaVersion: 1,
		generatedAt: new Date(now).toISOString(),
		runner: {
			state: lease ? "running" : "stopped",
			heartbeatAt: lease?.heartbeatAt ?? null,
		},
		accounts: store.list().map((account) => {
			const names = new Map(
				store.listOwnedGames(account.id).map((game) => [game.appId, game.name]),
			);
			const snapshot = snapshots.get(account.id) ?? null;
			const sessionStartedAt = snapshot?.snapshot.sessionStartedAt ?? null;
			return {
				id: account.id,
				accountName: account.accountName,
				steamId: account.steamId,
				status: account.status,
				activity: buildActivity(account, snapshot, names, now, lease !== null),
				sessionStartedAt,
				sessionUptimeSeconds:
					sessionStartedAt === null
						? null
						: secondsSince(sessionStartedAt, now),
				lastConnectedAt: account.lastConnectedAt,
				lastError: account.lastError,
				library: libraryStatus(
					store.getLibraryRefreshState(account.id),
					names.size,
					now,
				),
				snapshotRecordedAt: snapshot?.recordedAt ?? null,
			};
		}),
	};
}

function paint(
	text: string,
	color: StatusFormatOptions["color"],
	style: Parameters<typeof styleText>[0],
): string {
	return color ? styleText(style, text) : text;
}

function strongPaint(
	text: string,
	color: StatusFormatOptions["color"],
	style: `#${string}`,
): string {
	return color ? styleText("bold", styleText(style, text)) : text;
}

function formatDuration(seconds: number): string {
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	if (hours < 24) {
		return remainingMinutes === 0
			? `${hours}h`
			: `${hours}h ${remainingMinutes}m`;
	}
	const days = Math.floor(hours / 24);
	return `${days}d ${hours % 24}h`;
}

function until(timestamp: string, now: number): string {
	return formatDuration(
		Math.max(0, Math.ceil((Date.parse(timestamp) - now) / 1_000)),
	);
}

function gameLabel(game: StatusGame): string {
	return sanitize(game.name ?? `AppID ${game.appId}`);
}

function sanitize(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal output must not contain stored control characters.
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
}

function activityLabel(kind: StatusActivity["kind"]): string {
	return {
		disabled: "DISABLED",
		idle: "IDLE",
		connecting: "CONNECTING",
		boosting: "BOOSTING",
		farming: "FARMING",
		waiting_external_game: "PLAYING ELSEWHERE",
		retrying: "RETRYING",
		needs_auth: "AUTH REQUIRED",
		error: "ERROR",
	}[kind];
}

function activityColor(
	kind: StatusActivity["kind"],
): (typeof PALETTE)[keyof typeof PALETTE] {
	if (kind === "boosting" || kind === "farming") {
		return PALETTE.mint;
	}
	if (kind === "error" || kind === "needs_auth") {
		return PALETTE.rose;
	}
	if (kind === "disabled") {
		return PALETTE.mist;
	}
	return PALETTE.lilac;
}

function activityDetail(account: AccountFleetStatus, now: number): string {
	const activity = account.activity;
	if (activity.kind === "boosting") {
		const games = activity.games.map(gameLabel);
		if (activity.customGame) {
			games.push(activity.customGame);
		}
		return games.length > 0 ? games.join(", ") : "Applying presence";
	}
	if (activity.kind === "farming") {
		if (activity.games[0] === undefined) {
			return "Scanning for card drops";
		}
		const fields = [gameLabel(activity.games[0])];
		if (activity.remainingDrops !== null) {
			fields.push(
				`${activity.remainingDrops} ${activity.remainingDrops === 1 ? "drop" : "drops"}`,
			);
		}
		if (activity.queueLength !== null) {
			fields.push(
				`queue ${activity.queuePosition ?? 1}/${activity.queueLength}`,
			);
		}
		return fields.join("  ·  ");
	}
	if (activity.kind === "waiting_external_game") {
		const game = activity.externalGame
			? gameLabel(activity.externalGame)
			: "Another Steam session is active";
		return activity.nextCheckAt
			? `${game}  ·  check in ${until(activity.nextCheckAt, now)}`
			: game;
	}
	if (activity.kind === "retrying") {
		return activity.retryAt
			? `Attempt ${activity.attempt ?? 1} in ${until(activity.retryAt, now)}`
			: `Attempt ${activity.attempt ?? 1} scheduled`;
	}
	if (activity.kind === "connecting") {
		return `Attempt ${activity.attempt ?? 1}`;
	}
	if (activity.kind === "needs_auth") {
		return "Open linger manage to sign in again";
	}
	if (activity.kind === "error") {
		return "Automatic restart is disabled";
	}
	return "";
}

function ellipsize(value: string, maximum: number): string {
	const safe = sanitize(value);
	if (safe.length <= maximum) {
		return safe;
	}
	return maximum <= 1 ? "…" : `${safe.slice(0, maximum - 1)}…`;
}

function packDetails(values: readonly string[], maximum: number): string[] {
	const rows: string[] = [];
	let current = "";
	for (const value of values.map(sanitize).filter(Boolean)) {
		const candidate = current ? `${current}  ·  ${value}` : value;
		if (candidate.length <= maximum) {
			current = candidate;
			continue;
		}
		if (current) {
			rows.push(current);
		}
		current = ellipsize(value, maximum);
	}
	if (current) {
		rows.push(current);
	}
	return rows;
}

type SecondaryDetails = {
	state: string;
	details: string[];
};

function secondaryDetails(
	account: AccountFleetStatus,
	now: number,
): SecondaryDetails {
	const details: string[] = [];
	const state =
		account.sessionUptimeSeconds === null
			? ""
			: `session ${formatDuration(account.sessionUptimeSeconds)}`;
	if (account.library.ageSeconds !== null) {
		details.push(`library ${formatDuration(account.library.ageSeconds)} old`);
	} else if (account.library.cachedGames > 0) {
		details.push("library age unknown");
	} else {
		details.push("library not cached");
	}
	if (account.activity.nextCheckAt && account.activity.kind === "farming") {
		details.push(`next check ${until(account.activity.nextCheckAt, now)}`);
	}
	const nextAutoStop = [...account.activity.autoStop].sort(
		(left, right) =>
			Date.parse(left.estimatedCompletionAt) -
			Date.parse(right.estimatedCompletionAt),
	)[0];
	if (nextAutoStop) {
		details.push(
			`auto-stop ${gameLabel(nextAutoStop)} ${Math.floor(nextAutoStop.currentMinutes / 60)}h ${Math.floor(nextAutoStop.currentMinutes % 60)}m/${Math.floor(nextAutoStop.targetMinutes / 60)}h`,
		);
		details.push(`ETA ${until(nextAutoStop.estimatedCompletionAt, now)}`);
	}
	return { state, details };
}

export function formatFleetStatus(
	fleet: FleetStatus,
	options: StatusFormatOptions,
): string {
	const now = Date.parse(fleet.generatedAt);
	const width = Math.max(32, options.width ?? 100);
	const compact = width < 60;
	const color = options.color;
	const runner =
		fleet.runner.state === "running"
			? paint("● RUNNER ONLINE", color, PALETTE.mint)
			: paint("● RUNNER STOPPED", color, PALETTE.rose);
	const lines = [""];
	if (compact) {
		lines.push(
			`  ${strongPaint("◷  LINGER FLEET", color, PALETTE.lilac)}`,
			`  ${runner}`,
		);
	} else {
		lines.push(
			`  ${strongPaint("◷  LINGER FLEET", color, PALETTE.lilac)}  ${runner}`,
		);
	}
	lines.push(
		`  ${paint("━".repeat(Math.min(width - 4, 76)), color, PALETTE.plum)}`,
	);
	if (fleet.accounts.length === 0) {
		lines.push(
			"",
			`  ${paint(ellipsize("No accounts configured. Open linger manage to add one.", width - 4), color, PALETTE.mist)}`,
		);
	}
	const nameWidth = Math.min(
		20,
		Math.max(
			10,
			...fleet.accounts.map((account) => account.accountName.length),
		),
	);
	const stateWidth = 17;
	const detailColumn = 5 + nameWidth + 2 + stateWidth + 1;
	for (const account of fleet.accounts) {
		const stateColor = activityColor(account.activity.kind);
		if (compact) {
			const available = width - 5;
			const compactSecondary = secondaryDetails(account, now);
			const compactDetails = packDetails(
				[compactSecondary.state, ...compactSecondary.details],
				available,
			);
			const errors = [
				account.lastError ? `account: ${account.lastError}` : null,
				account.library.lastError
					? `library: ${account.library.lastError}`
					: null,
			].filter((error): error is string => error !== null);
			lines.push(
				"",
				`  ${paint("◆", color, stateColor)}  ${strongPaint(ellipsize(account.accountName, available), color, PALETTE.lilac)}`,
				`  ${paint("│", color, PALETTE.plum)}  ${paint(ellipsize(activityLabel(account.activity.kind), available), color, stateColor)}`,
			);
			const detail = activityDetail(account, now);
			if (detail) {
				lines.push(
					`  ${paint("│", color, PALETTE.plum)}  ${ellipsize(detail, available)}`,
				);
			}
			for (const row of compactDetails) {
				lines.push(
					`  ${paint("│", color, PALETTE.plum)}  ${paint(row, color, PALETTE.mist)}`.trimEnd(),
				);
			}
			if (errors.length > 0) {
				lines.push(
					`  ${paint("│", color, PALETTE.plum)}  ${paint(ellipsize(errors.join("  ·  "), available), color, PALETTE.rose)}`,
				);
			}
			continue;
		}
		const name = ellipsize(account.accountName, nameWidth).padEnd(nameWidth);
		const label = activityLabel(account.activity.kind).padEnd(stateWidth);
		const detail = ellipsize(
			activityDetail(account, now),
			Math.max(10, width - detailColumn),
		);
		lines.push(
			"",
			`  ${paint("◆", color, stateColor)}  ${strongPaint(name, color, PALETTE.lilac)}  ${paint(label, color, stateColor)} ${detail}`.trimEnd(),
		);
		const secondary = secondaryDetails(account, now);
		const detailWidth = Math.max(10, width - detailColumn);
		const secondaryRows = packDetails(secondary.details, detailWidth);
		const secondaryState = ellipsize(secondary.state, stateWidth).padEnd(
			stateWidth,
		);
		for (const [index, row] of secondaryRows.entries()) {
			const state = index === 0 ? secondaryState : " ".repeat(stateWidth);
			lines.push(
				`  ${paint("│", color, PALETTE.plum)}  ${" ".repeat(nameWidth)}  ${paint(state, color, PALETTE.mist)} ${paint(row, color, PALETTE.mist)}`.trimEnd(),
			);
		}
		const errors = [
			account.lastError ? `account: ${account.lastError}` : null,
			account.library.lastError
				? `library: ${account.library.lastError}`
				: null,
		].filter((error): error is string => error !== null);
		if (errors.length > 0) {
			lines.push(
				`  ${paint("│", color, PALETTE.plum)}  ${" ".repeat(nameWidth + 2 + stateWidth + 1)}${paint(ellipsize(errors.join("  ·  "), Math.max(10, width - detailColumn)), color, PALETTE.rose)}`.trimEnd(),
			);
		}
	}
	lines.push(
		"",
		options.watch
			? compact
				? `  ${strongPaint("q", color, PALETTE.lilac)} ${paint("quit", color, PALETTE.mist)}  ${paint("· 1s refresh", color, PALETTE.mist)}`
				: `  ${strongPaint("q", color, PALETTE.lilac)} ${paint("quit", color, PALETTE.mist)}  ${paint("· refreshes every second", color, PALETTE.mist)}`
			: `  ${paint(ellipsize(`Updated ${fleet.generatedAt}`, width - 4), color, PALETTE.mist)}`,
		"",
	);
	return lines.join("\n");
}

function useColor(stream: NodeJS.WriteStream): boolean {
	if (process.env.NO_COLOR !== undefined || process.env.FORCE_COLOR === "0") {
		return false;
	}
	return process.env.FORCE_COLOR !== undefined || stream.isTTY;
}

export function printStatus(store: AccountStore, json: boolean): void {
	const fleet = buildFleetStatus(store);
	if (json) {
		process.stdout.write(`${JSON.stringify(fleet, null, 2)}\n`);
		return;
	}
	process.stdout.write(
		formatFleetStatus(fleet, {
			color: useColor(process.stdout),
			width: process.stdout.columns,
		}),
	);
}

export async function watchStatus(store: AccountStore): Promise<void> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error("linger status --watch requires an interactive terminal");
	}
	const input = process.stdin as ReadStream;
	const output = process.stdout as WriteStream;
	const wasRaw = input.isRaw;
	const wasFlowing = input.readableFlowing === true;
	let timer: NodeJS.Timeout | null = null;
	let resolveStop: (() => void) | null = null;
	let rejectStop: ((error: unknown) => void) | null = null;
	const stopped = new Promise<void>((resolve, reject) => {
		resolveStop = resolve;
		rejectStop = reject;
	});
	const render = (): void => {
		const content = formatFleetStatus(buildFleetStatus(store), {
			color: useColor(process.stdout),
			width: output.columns,
			watch: true,
		});
		output.write(`\u001b[H\u001b[2J${content}`);
	};
	const onInput = (chunk: Buffer): void => {
		if (
			[...chunk].some(
				(byte) => byte === 3 || byte === 27 || byte === 81 || byte === 113,
			)
		) {
			resolveStop?.();
		}
	};
	const onSignal = (): void => resolveStop?.();
	try {
		if (!wasRaw) {
			input.setRawMode(true);
		}
		input.resume();
		input.on("data", onInput);
		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);
		output.write("\u001b[?1049h\u001b[?25l");
		render();
		timer = setInterval(() => {
			try {
				render();
			} catch (error) {
				rejectStop?.(error);
			}
		}, 1_000);
		await stopped;
	} finally {
		if (timer) {
			clearInterval(timer);
		}
		input.removeListener("data", onInput);
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
		if (!wasRaw) {
			input.setRawMode(false);
		}
		if (!wasFlowing) {
			input.pause();
		}
		output.write("\u001b[?25h\u001b[?1049l");
	}
}
