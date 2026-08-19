export const MAX_GAMES_PLAYED = 32;
export const MAX_CUSTOM_GAME_LENGTH = 128;
export const RECENT_ACTIVITY_RESERVED_SLOTS = 3;

export type AccountStatus =
	| "disabled"
	| "idle"
	| "connecting"
	| "online"
	| "backoff"
	| "needs_auth"
	| "error";

export type Account = {
	id: string;
	accountName: string;
	steamId: string | null;
	refreshTokenEncrypted: string;
	machineAuthTokenEncrypted: string | null;
	appIds: number[];
	autoStopTargets: AutoStopTarget[];
	customGame: string | null;
	awayMessage: string | null;
	visible: boolean;
	clearRecentActivity: boolean;
	cardFarmingEnabled: boolean;
	cardFarmingQueue: CardFarmingEntry[];
	autoRestart: boolean;
	enabled: boolean;
	revision: number;
	restartNonce: number;
	status: AccountStatus;
	lastError: string | null;
	lastConnectedAt: string | null;
	createdAt: string;
	updatedAt: string;
};

export type AutoStopTarget = {
	appId: number;
	targetMinutes: number;
};

export type CardFarmingEntry = {
	appId: number;
	remainingDrops: number;
};

export type NewAccount = Omit<
	Account,
	| "id"
	| "awayMessage"
	| "cardFarmingQueue"
	| "autoRestart"
	| "revision"
	| "restartNonce"
	| "status"
	| "lastError"
	| "lastConnectedAt"
	| "createdAt"
	| "updatedAt"
> & { autoRestart?: boolean };

export type AccountConfiguration = Pick<
	Account,
	| "appIds"
	| "autoStopTargets"
	| "customGame"
	| "visible"
	| "clearRecentActivity"
>;

export type AccountSetup = AccountConfiguration &
	Pick<Account, "cardFarmingEnabled">;

export type RuntimePatch = Partial<
	Pick<
		Account,
		| "steamId"
		| "status"
		| "lastError"
		| "lastConnectedAt"
		| "refreshTokenEncrypted"
		| "machineAuthTokenEncrypted"
	>
>;

export function parseAppIds(input: string): number[] {
	const values = input
		.split(/[\s,]+/u)
		.map((value) => value.trim())
		.filter(Boolean);

	const appIds: number[] = [];
	const seen = new Set<number>();
	for (const value of values) {
		if (!/^\d+$/u.test(value)) {
			throw new Error(`Invalid AppID: ${value}`);
		}
		const appId = Number(value);
		if (!Number.isSafeInteger(appId) || appId <= 0 || appId > 0xffff_ffff) {
			throw new Error(`Invalid AppID: ${value}`);
		}
		if (!seen.has(appId)) {
			seen.add(appId);
			appIds.push(appId);
		}
	}

	return appIds;
}

export function validatePresence(configuration: AccountConfiguration): void {
	validatePresenceSlots(configuration);
	if (!hasNormalPresence(configuration)) {
		throw new Error("Configure at least one AppID or a custom game name");
	}
}

export function hasNormalPresence(
	configuration: Pick<Account, "appIds" | "customGame">,
): boolean {
	return (
		configuration.appIds.length > 0 || Boolean(configuration.customGame?.trim())
	);
}

export function validateAccountSetup(configuration: AccountSetup): void {
	validatePresenceSlots(configuration);
	if (!configuration.cardFarmingEnabled && !hasNormalPresence(configuration)) {
		throw new Error(
			"Configure at least one AppID, a custom game name, or card farming",
		);
	}
}

export function validateAutoStopTargets(
	targets: readonly AutoStopTarget[],
	appIds: readonly number[],
): void {
	const selectedAppIds = new Set(appIds);
	const seen = new Set<number>();
	for (const target of targets) {
		if (
			!Number.isSafeInteger(target.appId) ||
			target.appId <= 0 ||
			target.appId > 0xffff_ffff
		) {
			throw new Error(`Invalid auto-stop AppID: ${target.appId}`);
		}
		if (
			!Number.isSafeInteger(target.targetMinutes) ||
			target.targetMinutes <= 0
		) {
			throw new Error(`Invalid auto-stop target for AppID ${target.appId}`);
		}
		if (seen.has(target.appId)) {
			throw new Error(`Duplicate auto-stop AppID: ${target.appId}`);
		}
		if (!selectedAppIds.has(target.appId)) {
			throw new Error(
				`Auto-stop AppID ${target.appId} must be a selected game`,
			);
		}
		seen.add(target.appId);
	}
}

export function validateCardFarmingQueue(
	queue: readonly CardFarmingEntry[],
): void {
	const seen = new Set<number>();
	for (const entry of queue) {
		if (
			!Number.isSafeInteger(entry.appId) ||
			entry.appId <= 0 ||
			entry.appId > 0xffff_ffff
		) {
			throw new Error(`Invalid card-farming AppID: ${entry.appId}`);
		}
		if (
			!Number.isSafeInteger(entry.remainingDrops) ||
			entry.remainingDrops <= 0
		) {
			throw new Error(`Invalid remaining card drops for AppID ${entry.appId}`);
		}
		if (seen.has(entry.appId)) {
			throw new Error(`Duplicate card-farming AppID: ${entry.appId}`);
		}
		seen.add(entry.appId);
	}
}

function validatePresenceSlots(configuration: AccountConfiguration): void {
	validateAutoStopTargets(configuration.autoStopTargets, configuration.appIds);
	const customGame = configuration.customGame?.trim() || null;
	if (customGame && customGame.length > MAX_CUSTOM_GAME_LENGTH) {
		throw new Error(
			`Custom game name must be ${MAX_CUSTOM_GAME_LENGTH} characters or fewer`,
		);
	}
	const slots = configuration.appIds.length + (customGame ? 1 : 0);
	const availableSlots = configuration.clearRecentActivity
		? MAX_GAMES_PLAYED - RECENT_ACTIVITY_RESERVED_SLOTS
		: MAX_GAMES_PLAYED;
	if (slots > availableSlots) {
		throw new Error(
			configuration.clearRecentActivity
				? `Recent-activity clearing leaves room for at most ${availableSlots} games`
				: `Steam supports at most ${MAX_GAMES_PLAYED} simultaneous games`,
		);
	}
	for (const appId of configuration.appIds) {
		if (!Number.isSafeInteger(appId) || appId <= 0 || appId > 0xffff_ffff) {
			throw new Error(`Invalid AppID: ${appId}`);
		}
	}
}
