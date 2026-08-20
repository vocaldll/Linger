export type AutoStopRuntimeProgress = {
	appId: number;
	observedMinutes: number;
	targetMinutes: number;
	observedAt: string;
	estimatedCompletionAt: string;
};

export type RuntimeActivity =
	| { kind: "disabled" }
	| { kind: "idle" }
	| { kind: "connecting"; attempt: number }
	| {
			kind: "boosting";
			appIds: number[];
			customGame: string | null;
			autoStop: AutoStopRuntimeProgress[];
	  }
	| {
			kind: "farming";
			appId: number | null;
			remainingDrops: number | null;
			queueLength: number;
			nextCheckAt: string | null;
	  }
	| {
			kind: "waiting_external_game";
			externalAppId: number | null;
			nextCheckAt: string | null;
	  }
	| { kind: "retrying"; attempt: number; retryAt: string }
	| { kind: "needs_auth" }
	| { kind: "error" };

export type RuntimeSnapshot = {
	version: 1;
	activity: RuntimeActivity;
	activitySince: string;
	sessionStartedAt: string | null;
	externalAppId: number | null;
};

export type StoredRuntimeSnapshot = {
	accountId: string;
	runnerOwnerId: string;
	snapshot: RuntimeSnapshot;
	recordedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNullableTimestamp(value: unknown): value is string | null {
	return value === null || isTimestamp(value);
}

function isAppId(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value > 0 &&
		value <= 0xffff_ffff
	);
}

function isNullableAppId(value: unknown): value is number | null {
	return value === null || isAppId(value);
}

function isAppIds(value: unknown): value is number[] {
	return Array.isArray(value) && value.every(isAppId);
}

function isAutoStopProgress(value: unknown): value is AutoStopRuntimeProgress {
	return (
		isRecord(value) &&
		isAppId(value.appId) &&
		typeof value.observedMinutes === "number" &&
		Number.isFinite(value.observedMinutes) &&
		value.observedMinutes >= 0 &&
		typeof value.targetMinutes === "number" &&
		Number.isFinite(value.targetMinutes) &&
		value.targetMinutes > 0 &&
		isTimestamp(value.observedAt) &&
		isTimestamp(value.estimatedCompletionAt)
	);
}

function isRuntimeActivity(value: unknown): value is RuntimeActivity {
	if (!isRecord(value) || typeof value.kind !== "string") {
		return false;
	}
	if (
		value.kind === "disabled" ||
		value.kind === "idle" ||
		value.kind === "needs_auth" ||
		value.kind === "error"
	) {
		return true;
	}
	if (value.kind === "connecting") {
		return Number.isSafeInteger(value.attempt) && Number(value.attempt) >= 1;
	}
	if (value.kind === "boosting") {
		return (
			isAppIds(value.appIds) &&
			isNullableString(value.customGame) &&
			Array.isArray(value.autoStop) &&
			value.autoStop.every(isAutoStopProgress)
		);
	}
	if (value.kind === "farming") {
		return (
			isNullableAppId(value.appId) &&
			(value.remainingDrops === null ||
				(Number.isSafeInteger(value.remainingDrops) &&
					Number(value.remainingDrops) > 0)) &&
			Number.isSafeInteger(value.queueLength) &&
			Number(value.queueLength) >= 0 &&
			isNullableTimestamp(value.nextCheckAt)
		);
	}
	if (value.kind === "waiting_external_game") {
		return (
			isNullableAppId(value.externalAppId) &&
			isNullableTimestamp(value.nextCheckAt)
		);
	}
	if (value.kind === "retrying") {
		return (
			Number.isSafeInteger(value.attempt) &&
			Number(value.attempt) >= 1 &&
			isTimestamp(value.retryAt)
		);
	}
	return false;
}

export function parseRuntimeSnapshot(value: string): RuntimeSnapshot {
	const parsed: unknown = JSON.parse(value);
	if (
		!isRecord(parsed) ||
		parsed.version !== 1 ||
		!isRuntimeActivity(parsed.activity) ||
		!isTimestamp(parsed.activitySince) ||
		!isNullableTimestamp(parsed.sessionStartedAt) ||
		!isNullableAppId(parsed.externalAppId)
	) {
		throw new Error("Stored account has an invalid runtime snapshot");
	}
	return parsed as RuntimeSnapshot;
}
