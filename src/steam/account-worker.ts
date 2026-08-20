import { performance } from "node:perf_hooks";
import SteamUser from "steam-user";
import type { CredentialVault } from "../crypto.js";
import type { AccountStore } from "../database.js";
import type { Account, AutoStopTarget } from "../domain/account.js";
import type {
	AutoStopRuntimeProgress,
	RuntimeActivity,
} from "../domain/runtime-snapshot.js";
import { logger } from "../logger.js";
import { CardFarmingController } from "./card-farming.js";
import {
	type CommunityProfileStatus,
	type ProfileStatus,
	SteamCommunityAuthenticationError,
	SteamCommunityCardService,
} from "./community-cards.js";
import { getOwnedGamePlaytimes, loadGameLibrary } from "./game-library.js";
import type { SteamMachineIdentity } from "./machine-identity.js";
import { PresenceController, type PresenceIntent } from "./presence.js";

const INITIAL_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60 * 1_000;
const LOGGED_IN_ELSEWHERE_RETRY_MS = 45 * 60 * 1_000;
const PROFILE_STATUS_POLL_INTERVAL_MS = 30_000;
const PROFILE_STATUS_CONFIRMATIONS_REQUIRED = 2;
const EARLY_RETRY_STABILITY_MS = 30_000;
export const AWAY_MESSAGE_COOLDOWN_MS = 30 * 60 * 1_000;
export const MAX_AUTO_STOP_TIMER_MS = 24 * 60 * 60 * 1_000;
const AUTO_STOP_RETRY_MS = 2 * 60 * 1_000;

export function calculateAutoStopCheckDelay(
	targets: readonly AutoStopTarget[],
	playtimes: ReadonlyMap<number, number>,
	activeDurationMs: number,
	maximumDelayMs = MAX_AUTO_STOP_TIMER_MS,
): number {
	return Math.max(
		0,
		Math.min(
			...targets.map(
				(target) =>
					(target.targetMinutes - (playtimes.get(target.appId) ?? 0)) * 60_000 -
					activeDurationMs,
			),
			maximumDelayMs,
		),
	);
}

export function findReachedAutoStopTargets(
	targets: readonly AutoStopTarget[],
	playtimes: ReadonlyMap<number, number>,
	activeDurationMs: number,
): AutoStopTarget[] {
	return targets.filter(
		(target) =>
			(target.targetMinutes - (playtimes.get(target.appId) ?? 0)) * 60_000 <=
			activeDurationMs,
	);
}

export function selectCurrentAutoStopTargets(
	snapshot: Account,
	persisted: Account,
	targets: readonly AutoStopTarget[],
): AutoStopTarget[] {
	if (
		persisted.id !== snapshot.id ||
		persisted.restartNonce !== snapshot.restartNonce ||
		persisted.refreshTokenEncrypted !== snapshot.refreshTokenEncrypted ||
		persisted.machineAuthTokenEncrypted !==
			snapshot.machineAuthTokenEncrypted ||
		configuredAppsChanged(snapshot, persisted) ||
		!persisted.enabled ||
		persisted.cardFarmingEnabled
	) {
		return [];
	}
	return targets.filter(
		(target) =>
			persisted.appIds.includes(target.appId) &&
			persisted.autoStopTargets.some(
				(current) =>
					current.appId === target.appId &&
					current.targetMinutes === target.targetMinutes,
			),
	);
}

type SteamUserWithMachineTokenEvent = SteamUser & {
	on(event: "machineAuthToken", listener: (token: string) => void): SteamUser;
};

type SteamError = Error & { eresult?: number };
type AppliedPresenceMode = "card-farming" | "hour-boosting";
type GameExitWait = {
	nextCheckAt: number;
	checkInFlight: boolean;
	lastStatus: "online" | "offline" | null;
	consecutiveMatches: number;
};

export type ProfileStatusAssessment =
	| {
			action: "wait";
			lastStatus: "online" | "offline" | null;
			consecutiveMatches: number;
	  }
	| { action: "retry"; mode: "confirmed-exit" | "offline-probe" }
	| { action: "fallback" };

type WebLogOnClient = {
	steamID: unknown;
	webLogOn(): void;
};

export function guardWebLogOnAfterDisconnect(client: WebLogOnClient): void {
	const webLogOn = client.webLogOn.bind(client);
	client.webLogOn = () => {
		// steam-user automatically continues into webLogOn after its async refresh-token renewal.
		// A fatal disconnect during that renewal clears steamID and would otherwise throw here.
		if (client.steamID) {
			webLogOn();
		}
	};
}

function isAuthenticationError(error: SteamError): boolean {
	return /InvalidPassword|AccessDenied|Expired|Revoked/iu.test(error.message);
}

function isLoggedInElsewhere(error: SteamError): boolean {
	return /LoggedInElsewhere|LogonSessionReplaced/iu.test(error.message);
}

export function assessProfileStatus(
	status: ProfileStatus,
	lastStatus: "online" | "offline" | null,
	consecutiveMatches: number,
): ProfileStatusAssessment {
	if (status === "unknown") {
		return { action: "fallback" };
	}
	if (status === "in-game") {
		return { action: "wait", lastStatus: null, consecutiveMatches: 0 };
	}
	const confirmations = status === lastStatus ? consecutiveMatches + 1 : 1;
	return confirmations >= PROFILE_STATUS_CONFIRMATIONS_REQUIRED
		? {
				action: "retry",
				mode: status === "online" ? "confirmed-exit" : "offline-probe",
			}
		: {
				action: "wait",
				lastStatus: status,
				consecutiveMatches: confirmations,
			};
}

export function extendEarlyRetryProtection(
	protectionUntil: number,
	now: number,
): number {
	return protectionUntil > now ? now + EARLY_RETRY_STABILITY_MS : 0;
}

export class AwayMessageCooldown {
	readonly #replyTimes = new Map<string, number>();

	reserve(senderId: string, now = Date.now()): number | null {
		const lastReplyAt = this.#replyTimes.get(senderId);
		if (
			lastReplyAt !== undefined &&
			now - lastReplyAt < AWAY_MESSAGE_COOLDOWN_MS
		) {
			return null;
		}
		this.#replyTimes.set(senderId, now);
		return now;
	}

	release(senderId: string, replyAt: number): void {
		if (this.#replyTimes.get(senderId) === replyAt) {
			this.#replyTimes.delete(senderId);
		}
	}
}

export function presenceChanged(previous: Account, next: Account): boolean {
	return (
		previous.visible !== next.visible ||
		previous.clearRecentActivity !== next.clearRecentActivity ||
		previous.cardFarmingEnabled !== next.cardFarmingEnabled ||
		previous.cardFarmingQueue[0]?.appId !== next.cardFarmingQueue[0]?.appId ||
		previous.customGame !== next.customGame ||
		configuredAppsChanged(previous, next)
	);
}

export function buildAccountPresenceIntent(account: Account): PresenceIntent {
	return !account.enabled || account.cardFarmingEnabled
		? {
				mode: "farm",
				appId: account.enabled
					? (account.cardFarmingQueue[0]?.appId ?? null)
					: null,
				visible: account.enabled && account.visible,
			}
		: { mode: "boost", configuration: account };
}

function autoStopTargetsChanged(previous: Account, next: Account): boolean {
	return (
		JSON.stringify(previous.autoStopTargets) !==
		JSON.stringify(next.autoStopTargets)
	);
}

function configuredAppsChanged(previous: Account, next: Account): boolean {
	return JSON.stringify(previous.appIds) !== JSON.stringify(next.appIds);
}

export class AccountWorker {
	#record: Account;
	#client: SteamUser | null = null;
	#presence: PresenceController | null = null;
	#cardFarming: CardFarmingController | null = null;
	#connecting = false;
	#stopped = false;
	#generation = 0;
	#retryAttempt = 0;
	#retryAt = 0;
	#appliedPresenceMode: AppliedPresenceMode | null = null;
	#webCookies: readonly string[] | null = null;
	#gameExitWait: GameExitWait | null = null;
	#earlyRetryProtectionUntil = 0;
	#librarySyncGeneration: number | null = null;
	#presenceOperation = 0;
	#autoStopMonitoringRevision = 0;
	#autoStopTimer: NodeJS.Timeout | null = null;
	#autoStopTargetsSuppressed = false;
	#autoStopProgress: AutoStopRuntimeProgress[] = [];
	#sessionStartedAt: string | null = null;
	#externalAppId: number | null = null;
	#activitySince = new Date().toISOString();
	#lastActivityIdentity: string | null = null;
	#runtimeSnapshotPublished = false;
	#runtimePublishErrorLogged = false;
	readonly #awayMessageCooldown = new AwayMessageCooldown();

	constructor(
		private readonly store: AccountStore,
		private readonly vault: CredentialVault,
		account: Account,
		private readonly machineIdentity: SteamMachineIdentity,
		private readonly runnerOwnerId: string,
		private readonly communityProfileStatus: CommunityProfileStatus = new SteamCommunityCardService(),
	) {
		this.#record = account;
		if (
			account.status === "needs_auth" ||
			(!account.autoRestart && account.status === "error")
		) {
			this.#retryAt = Number.POSITIVE_INFINITY;
		}
	}

	get accountName(): string {
		return this.#record.accountName;
	}

	reconcile(next: Account): void {
		if (this.#stopped) {
			return;
		}

		const previous = this.#record;
		const credentialsChanged =
			previous.refreshTokenEncrypted !== next.refreshTokenEncrypted ||
			previous.machineAuthTokenEncrypted !== next.machineAuthTokenEncrypted;
		const restartRequested = previous.restartNonce !== next.restartNonce;
		const autoRestartEnabled = !previous.autoRestart && next.autoRestart;
		const autoRestartDisabled = previous.autoRestart && !next.autoRestart;
		const targetsChanged = autoStopTargetsChanged(previous, next);
		this.#record = next;
		this.#cardFarming?.reconcile(next);

		if (!next.enabled) {
			const cardScan = this.store.getCardFarmingScanState(next.id);
			if (cardScan.requestedNonce > cardScan.completedNonce) {
				this.#stopHourBoosting("disabled");
				const connectionBlocked =
					next.status === "needs_auth" ||
					(!next.autoRestart && next.status === "error");
				if (
					!connectionBlocked &&
					!this.#client &&
					!this.#connecting &&
					Date.now() >= this.#retryAt
				) {
					this.#connect();
				}
				if (!this.#runtimeSnapshotPublished) {
					this.#publishCurrentActivity();
				}
				return;
			}
			this.#stopHourBoosting("disabled");
			this.#disconnect();
			this.#retryAt = 0;
			this.#retryAttempt = 0;
			this.#gameExitWait = null;
			this.#earlyRetryProtectionUntil = 0;
			if (next.status !== "disabled") {
				this.#record = this.store.updateRuntime(next.id, {
					status: "disabled",
					lastError: null,
				});
			}
			this.#publishCurrentActivity();
			return;
		}

		if (credentialsChanged || restartRequested) {
			this.#disconnect();
			this.#retryAt = 0;
			this.#retryAttempt = 0;
			this.#gameExitWait = null;
			this.#earlyRetryProtectionUntil = 0;
		} else if (
			autoRestartDisabled &&
			!this.#client &&
			!this.#connecting &&
			next.status === "backoff"
		) {
			this.#retryAt = Number.POSITIVE_INFINITY;
			this.#gameExitWait = null;
			this.#earlyRetryProtectionUntil = 0;
			this.#webCookies = null;
			this.#record = this.store.updateRuntime(next.id, { status: "error" });
			this.#publishCurrentActivity();
		} else if (autoRestartEnabled && !this.#client && !this.#connecting) {
			this.#retryAt = 0;
			this.#retryAttempt = 0;
			this.#gameExitWait = null;
			this.#earlyRetryProtectionUntil = 0;
		} else if (this.#client) {
			if (presenceChanged(previous, next)) {
				this.#applyPresence();
			} else if (targetsChanged) {
				if (next.cardFarmingEnabled) {
					this.#resetAutoStopMonitoring();
				} else if (
					this.#appliedPresenceMode === "hour-boosting" &&
					!this.#autoStopTargetsSuppressed
				) {
					this.#refreshAutoStopMonitoring();
				} else {
					this.#applyPresence();
				}
			}
		}
		if (this.#client) {
			if (configuredAppsChanged(previous, next)) {
				this.store.requestLibraryRefresh(next.id);
			}
			const refresh = this.store.getLibraryRefreshState(next.id);
			if (refresh.requestedNonce > refresh.completedNonce) {
				void this.#syncLibrary(this.#generation, this.#client, next.id);
			}
		}

		if (!this.#client && !this.#connecting) {
			if (this.#gameExitWait) {
				void this.#checkProfileStatus();
			} else if (Date.now() >= this.#retryAt) {
				this.#connect();
			}
		}
		if (!this.#runtimeSnapshotPublished) {
			this.#publishCurrentActivity();
		}
	}

	stop(): void {
		this.#stopped = true;
		this.#disconnect();
		const persisted = this.store.get(this.#record.id);
		if (
			persisted?.enabled &&
			(persisted.autoRestart || persisted.status !== "error")
		) {
			this.store.updateRuntime(this.#record.id, { status: "idle" });
		}
	}

	#connect(): void {
		this.#connecting = true;
		const generation = ++this.#generation;
		const account = this.#record;
		let refreshToken: string;
		let machineAuthToken: string | undefined;
		try {
			refreshToken = this.vault.decrypt(account.refreshTokenEncrypted);
			machineAuthToken = account.machineAuthTokenEncrypted
				? this.vault.decrypt(account.machineAuthTokenEncrypted)
				: undefined;
		} catch (error) {
			this.#connecting = false;
			this.#retryAt = Number.POSITIVE_INFINITY;
			this.#record = this.store.updateRuntime(account.id, {
				status: "needs_auth",
				lastError: error instanceof Error ? error.message : String(error),
			});
			this.#publishCurrentActivity();
			return;
		}

		const client = new SteamUser({
			autoRelogin: false,
			renewRefreshTokens: true,
			dataDirectory: null,
			enablePicsCache: false,
			machineIdFormat: [...this.machineIdentity.machineIdFormat],
			machineIdType: SteamUser.EMachineIDType.AccountNameGenerated,
		});
		guardWebLogOnAfterDisconnect(client);
		this.#client = client;
		this.#record = this.store.updateRuntime(account.id, {
			status: "connecting",
			lastError: null,
		});
		this.#publishCurrentActivity();
		logger.info("steam", "Connecting", { account: account.accountName });

		client.on("loggedOn", () => {
			if (!this.#isCurrent(generation, client)) {
				return;
			}
			this.#connecting = false;
			this.#retryAttempt = 0;
			this.#retryAt = 0;
			this.#gameExitWait = null;
			this.#earlyRetryProtectionUntil = extendEarlyRetryProtection(
				this.#earlyRetryProtectionUntil,
				Date.now(),
			);
			this.#sessionStartedAt = new Date().toISOString();
			this.#presence?.dispose();
			this.#presence = new PresenceController(client, 3_000, (error) => {
				logger.warn(
					"presence",
					"Recent-activity helpers unavailable; continuing",
					{
						account: this.#record.accountName,
						error: error instanceof Error ? error.message : String(error),
					},
				);
			});
			this.#cardFarming?.dispose();
			this.#cardFarming = new CardFarmingController(this.store, this.#record, {
				accountChanged: (updated) => {
					if (this.#isCurrent(generation, client)) {
						this.#record = updated;
					}
				},
				applyPresence: (updated) => {
					if (this.#isCurrent(generation, client)) {
						this.#record = updated;
						this.#applyPresence();
					}
				},
				refreshWebSession: () => {
					if (!this.#isCurrent(generation, client)) {
						return;
					}
					try {
						client.webLogOn();
					} catch (error) {
						logger.warn("cards", "Could not refresh Community session", {
							account: this.#record.accountName,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				},
				stateChanged: () => {
					if (this.#isCurrent(generation, client)) {
						this.#publishCurrentActivity();
					}
				},
			});
			this.#applyPresence();
			void this.#syncLibrary(generation, client, account.id);
			const latest = this.store.get(account.id);
			if (latest) {
				this.#record = this.store.updateRuntime(account.id, {
					status: "online",
					lastError: null,
					steamId: client.steamID?.getSteamID64() ?? latest.steamId,
					lastConnectedAt: new Date().toISOString(),
				});
			}
			this.#publishCurrentActivity();
			logger.info("steam", "Connected", {
				account: account.accountName,
				steamId: client.steamID?.getSteamID64() ?? null,
			});
		});

		client.on("refreshToken", (token) => {
			if (!this.#isCurrent(generation, client)) {
				return;
			}
			this.#record = this.store.updateRuntime(account.id, {
				refreshTokenEncrypted: this.vault.encrypt(token),
			});
			logger.debug("steam", "Saved renewed token", {
				account: account.accountName,
			});
		});

		(client as SteamUserWithMachineTokenEvent).on(
			"machineAuthToken",
			(token) => {
				if (!this.#isCurrent(generation, client)) {
					return;
				}
				this.#record = this.store.updateRuntime(account.id, {
					machineAuthTokenEncrypted: this.vault.encrypt(token),
				});
			},
		);

		client.on("webSession", (_sessionId, cookies) => {
			if (this.#isCurrent(generation, client)) {
				this.#webCookies = [...cookies];
				this.#cardFarming?.setWebSession(cookies);
			}
		});
		client.on("newItems", () => {
			if (this.#isCurrent(generation, client)) {
				this.#cardFarming?.notifyNewItems();
			}
		});
		client.on("playingState", (blocked, playingApp) => {
			if (!this.#isCurrent(generation, client)) {
				return;
			}
			this.#externalAppId = blocked && playingApp > 0 ? playingApp : null;
			this.#publishCurrentActivity();
		});
		client.chat.on("friendMessage", (message) => {
			if (!this.#isCurrent(generation, client)) {
				return;
			}
			const awayMessage = this.#record.awayMessage;
			if (!awayMessage) {
				return;
			}
			const senderId = message.steamid_friend.getSteamID64();
			const replyAt = this.#awayMessageCooldown.reserve(senderId);
			if (replyAt === null) {
				return;
			}
			void client.chat
				.sendFriendMessage(message.steamid_friend, awayMessage, {
					containsBbCode: false,
				})
				.then(
					() => {
						logger.debug("chat", "Away message sent", {
							account: this.#record.accountName,
							recipient: senderId,
						});
					},
					(error: unknown) => {
						this.#awayMessageCooldown.release(senderId, replyAt);
						logger.warn("chat", "Could not send away message", {
							account: this.#record.accountName,
							recipient: senderId,
							error: error instanceof Error ? error.message : String(error),
						});
					},
				);
		});

		client.on("steamGuard", () => {
			if (this.#isCurrent(generation, client)) {
				this.#fail(
					new Error("Stored login requires interactive authentication"),
					true,
				);
			}
		});
		client.on("error", (error) => {
			if (this.#isCurrent(generation, client)) {
				this.#fail(
					error as SteamError,
					isAuthenticationError(error as SteamError),
				);
			}
		});
		client.on("disconnected", (_result, message) => {
			if (this.#isCurrent(generation, client)) {
				this.#fail(new Error(message || "Steam disconnected"), false);
			}
		});

		try {
			client.logOn({
				refreshToken,
				...(machineAuthToken ? { machineAuthToken } : {}),
				machineName: this.machineIdentity.machineName,
			});
		} catch (error) {
			this.#fail(
				error instanceof Error ? error : new Error(String(error)),
				false,
			);
		}
	}

	#applyPresence(preflightAutoStops = true): void {
		const presence = this.#presence;
		const client = this.#client;
		if (!presence || !client) {
			return;
		}
		this.#resetAutoStopMonitoring();
		const operation = ++this.#presenceOperation;
		const monitoringRevision = this.#autoStopMonitoringRevision;
		void this.#applyPresenceOperation(
			operation,
			monitoringRevision,
			presence,
			client,
			preflightAutoStops,
		);
	}

	async #applyPresenceOperation(
		operation: number,
		monitoringRevision: number,
		presence: PresenceController,
		client: SteamUser,
		preflightAutoStops: boolean,
	): Promise<void> {
		const snapshot = this.#record;
		if (
			!snapshot.enabled ||
			snapshot.cardFarmingEnabled ||
			snapshot.autoStopTargets.length === 0 ||
			!preflightAutoStops
		) {
			try {
				const applied = await presence.apply(
					buildAccountPresenceIntent(snapshot),
				);
				if (applied) {
					this.#autoStopTargetsSuppressed = false;
				}
				this.#finishPresenceApplication(presence, snapshot, applied);
				if (
					applied &&
					!preflightAutoStops &&
					snapshot.enabled &&
					!snapshot.cardFarmingEnabled &&
					snapshot.autoStopTargets.length > 0
				) {
					this.#refreshAutoStopMonitoring();
				}
			} catch (error) {
				if (this.#isPresenceOperationCurrent(operation, presence, client)) {
					logger.error("presence", "Could not apply", {
						account: snapshot.accountName,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			return;
		}

		let playtimes: ReadonlyMap<number, number>;
		try {
			playtimes = await this.#loadAutoStopPlaytimes(snapshot, client);
		} catch (error) {
			if (!this.#isPresenceOperationCurrent(operation, presence, client)) {
				return;
			}
			logger.warn("presence", "Auto-stop playtime check failed", {
				account: snapshot.accountName,
				error: error instanceof Error ? error.message : String(error),
				retry: "2m",
			});
			try {
				const targetedAppIds = new Set(
					snapshot.autoStopTargets.map((target) => target.appId),
				);
				const untargetedAppIds = snapshot.appIds.filter(
					(appId) => !targetedAppIds.has(appId),
				);
				const applied = await presence.apply(
					this.#normalBoostIntent(snapshot, untargetedAppIds),
				);
				if (!this.#isPresenceOperationCurrent(operation, presence, client)) {
					return;
				}
				this.#autoStopTargetsSuppressed = applied;
				this.#finishPresenceApplication(presence, snapshot, applied);
				if (applied) {
					this.#scheduleAutoStopRetry(
						monitoringRevision,
						presence,
						client,
						() => this.#refreshAutoStopMonitoring(),
					);
				}
			} catch (presenceError) {
				if (this.#isPresenceOperationCurrent(operation, presence, client)) {
					logger.error("presence", "Could not apply", {
						account: snapshot.accountName,
						error:
							presenceError instanceof Error
								? presenceError.message
								: String(presenceError),
					});
				}
			}
			return;
		}

		if (!this.#isPresenceOperationCurrent(operation, presence, client)) {
			return;
		}
		const reached = findReachedAutoStopTargets(
			snapshot.autoStopTargets,
			playtimes,
			0,
		);
		if (reached.length > 0) {
			if (this.#completeAutoStops(reached).length > 0) {
				this.#applyPresence(false);
			}
			return;
		}

		const boostingStartedAt = performance.now();
		try {
			const applied = await presence.apply({
				mode: "boost",
				configuration: snapshot,
			});
			if (!this.#isPresenceOperationCurrent(operation, presence, client)) {
				return;
			}
			this.#autoStopTargetsSuppressed = false;
			this.#finishPresenceApplication(presence, snapshot, applied);
			if (
				applied &&
				this.#isAutoStopMonitoringCurrent(monitoringRevision, presence, client)
			) {
				this.#scheduleAutoStopCheck(
					monitoringRevision,
					presence,
					client,
					snapshot.autoStopTargets,
					playtimes,
					boostingStartedAt,
				);
			}
		} catch (error) {
			if (this.#isPresenceOperationCurrent(operation, presence, client)) {
				logger.error("presence", "Could not apply", {
					account: snapshot.accountName,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	#normalBoostIntent(account: Account, appIds: number[]): PresenceIntent {
		if (appIds.length === 0 && !account.customGame?.trim()) {
			return { mode: "farm", appId: null, visible: account.visible };
		}
		return {
			mode: "boost",
			configuration: { ...account, appIds, autoStopTargets: [] },
		};
	}

	#finishPresenceApplication(
		presence: PresenceController,
		snapshot: Account,
		applied: boolean,
	): void {
		if (!applied || presence !== this.#presence) {
			return;
		}
		if (!snapshot.enabled) {
			this.#appliedPresenceMode = null;
			this.#publishCurrentActivity();
			return;
		}
		const mode: AppliedPresenceMode = snapshot.cardFarmingEnabled
			? "card-farming"
			: "hour-boosting";
		if (mode === "card-farming" && !snapshot.cardFarmingQueue[0]) {
			if (this.#appliedPresenceMode === "hour-boosting") {
				this.#stopHourBoosting("card-farming");
			}
			return;
		}
		const fields = snapshot.cardFarmingEnabled
			? {
					account: snapshot.accountName,
					visibility: snapshot.visible ? "online" : "invisible",
				}
			: {
					account: snapshot.accountName,
					games: snapshot.appIds.length,
					...(snapshot.customGame ? { customGame: snapshot.customGame } : {}),
					visibility: snapshot.visible ? "online" : "invisible",
					...(snapshot.clearRecentActivity
						? { clearRecentActivity: true }
						: {}),
				};
		if (
			this.#appliedPresenceMode === "hour-boosting" &&
			mode === "card-farming"
		) {
			this.#stopHourBoosting("card-farming");
		}
		const label = mode === "card-farming" ? "Card farming" : "Hour boosting";
		const action = this.#appliedPresenceMode === mode ? "updated" : "started";
		logger.info("presence", `${label} ${action}`, fields);
		this.#appliedPresenceMode = mode;
		this.#publishCurrentActivity();
	}

	#refreshAutoStopMonitoring(): void {
		const presence = this.#presence;
		const client = this.#client;
		this.#resetAutoStopMonitoring();
		const snapshot = this.#record;
		if (
			!presence ||
			!client ||
			!snapshot.enabled ||
			snapshot.cardFarmingEnabled ||
			snapshot.autoStopTargets.length === 0
		) {
			return;
		}
		this.#publishCurrentActivity();
		const monitoringRevision = this.#autoStopMonitoringRevision;
		void this.#refreshAutoStopMonitoringOperation(
			monitoringRevision,
			presence,
			client,
			snapshot,
		);
	}

	async #refreshAutoStopMonitoringOperation(
		monitoringRevision: number,
		presence: PresenceController,
		client: SteamUser,
		snapshot: Account,
	): Promise<void> {
		try {
			const playtimes = await this.#loadAutoStopPlaytimes(snapshot, client);
			if (
				!this.#isAutoStopMonitoringCurrent(monitoringRevision, presence, client)
			) {
				return;
			}
			const reached = findReachedAutoStopTargets(
				snapshot.autoStopTargets,
				playtimes,
				0,
			);
			if (reached.length > 0) {
				if (this.#completeAutoStops(reached).length > 0) {
					this.#applyPresence(false);
				}
				return;
			}
			if (this.#autoStopTargetsSuppressed) {
				this.#applyPresence();
				return;
			}
			this.#scheduleAutoStopCheck(
				monitoringRevision,
				presence,
				client,
				snapshot.autoStopTargets,
				playtimes,
				performance.now(),
			);
		} catch (error) {
			if (
				!this.#isAutoStopMonitoringCurrent(monitoringRevision, presence, client)
			) {
				return;
			}
			logger.warn("presence", "Auto-stop playtime check failed", {
				account: snapshot.accountName,
				error: error instanceof Error ? error.message : String(error),
				retry: "2m",
			});
			this.#scheduleAutoStopRetry(monitoringRevision, presence, client, () =>
				this.#refreshAutoStopMonitoring(),
			);
		}
	}

	async #loadAutoStopPlaytimes(
		snapshot: Account,
		client: SteamUser,
	): Promise<ReadonlyMap<number, number>> {
		const steamId = client.steamID?.getSteamID64();
		if (!steamId) {
			throw new Error("Steam did not provide an account ID for auto-stop");
		}
		const playtimes = await getOwnedGamePlaytimes(
			client,
			steamId,
			snapshot.autoStopTargets.map((target) => target.appId),
		);
		const missingAppId = snapshot.autoStopTargets.find(
			(target) => !playtimes.has(target.appId),
		)?.appId;
		if (missingAppId !== undefined) {
			throw new Error(
				`Steam did not return playtime for AppID ${missingAppId}`,
			);
		}
		return playtimes;
	}

	#completeAutoStops(targets: readonly AutoStopTarget[]): AutoStopTarget[] {
		const persisted = this.store.get(this.#record.id);
		if (!persisted) {
			return [];
		}
		const currentTargets = selectCurrentAutoStopTargets(
			this.#record,
			persisted,
			targets,
		);
		for (const target of currentTargets) {
			this.#record = this.store.completeAutoStop(this.#record.id, target.appId);
			logger.info("presence", "Auto-stop target reached", {
				account: this.#record.accountName,
				app: target.appId,
				targetHours: target.targetMinutes / 60,
			});
		}
		return currentTargets;
	}

	#scheduleAutoStopCheck(
		monitoringRevision: number,
		presence: PresenceController,
		client: SteamUser,
		targets: readonly AutoStopTarget[],
		playtimes: ReadonlyMap<number, number>,
		boostingStartedAt: number,
	): void {
		this.#cancelAutoStopTimer();
		const delayMs = calculateAutoStopCheckDelay(
			targets,
			playtimes,
			performance.now() - boostingStartedAt,
		);
		this.#autoStopTimer = setTimeout(() => {
			this.#autoStopTimer = null;
			if (
				!this.#isAutoStopMonitoringCurrent(monitoringRevision, presence, client)
			) {
				return;
			}
			const reached = findReachedAutoStopTargets(
				targets,
				playtimes,
				performance.now() - boostingStartedAt,
			);
			if (reached.length === 0) {
				this.#scheduleAutoStopCheck(
					monitoringRevision,
					presence,
					client,
					targets,
					playtimes,
					boostingStartedAt,
				);
				return;
			}
			if (this.#completeAutoStops(reached).length > 0) {
				this.#applyPresence(false);
			}
		}, delayMs);
		const elapsedMs = performance.now() - boostingStartedAt;
		const observedAt = Date.now() - elapsedMs;
		this.#autoStopProgress = targets.map((target) => {
			const observedMinutes = playtimes.get(target.appId) ?? 0;
			return {
				appId: target.appId,
				observedMinutes,
				targetMinutes: target.targetMinutes,
				observedAt: new Date(observedAt).toISOString(),
				estimatedCompletionAt: new Date(
					observedAt +
						Math.max(0, target.targetMinutes - observedMinutes) * 60_000,
				).toISOString(),
			};
		});
		this.#publishCurrentActivity();
	}

	#scheduleAutoStopRetry(
		monitoringRevision: number,
		presence: PresenceController,
		client: SteamUser,
		retry: () => void,
	): void {
		this.#cancelAutoStopTimer();
		this.#autoStopTimer = setTimeout(() => {
			this.#autoStopTimer = null;
			if (
				this.#isAutoStopMonitoringCurrent(monitoringRevision, presence, client)
			) {
				retry();
			}
		}, AUTO_STOP_RETRY_MS);
	}

	#resetAutoStopMonitoring(): void {
		this.#autoStopMonitoringRevision += 1;
		this.#autoStopProgress = [];
		this.#cancelAutoStopTimer();
	}

	#cancelAutoStopTimer(): void {
		if (this.#autoStopTimer) {
			clearTimeout(this.#autoStopTimer);
			this.#autoStopTimer = null;
		}
	}

	#isPresenceOperationCurrent(
		operation: number,
		presence: PresenceController,
		client: SteamUser,
	): boolean {
		return (
			operation === this.#presenceOperation &&
			presence === this.#presence &&
			client === this.#client
		);
	}

	#isAutoStopMonitoringCurrent(
		monitoringRevision: number,
		presence: PresenceController,
		client: SteamUser,
	): boolean {
		return (
			monitoringRevision === this.#autoStopMonitoringRevision &&
			presence === this.#presence &&
			client === this.#client
		);
	}

	async #syncLibrary(
		generation: number,
		client: SteamUser,
		accountId: string,
	): Promise<void> {
		if (this.#librarySyncGeneration === generation) {
			return;
		}
		this.#librarySyncGeneration = generation;
		const refresh = this.store.getLibraryRefreshState(accountId);
		try {
			const steamId = client.steamID?.getSteamID64();
			if (!steamId) {
				throw new Error(
					"Steam did not provide an account ID for library loading",
				);
			}
			const { games, trackedPlaytimes } = await loadGameLibrary(
				client,
				steamId,
				this.#record.appIds,
			);
			if (!this.#isCurrent(generation, client)) {
				return;
			}
			this.store.replaceOwnedGames(accountId, games);
			if (trackedPlaytimes) {
				this.store.replaceTrackedPlaytimes(accountId, trackedPlaytimes);
			}
			this.store.completeLibraryRefresh(
				accountId,
				refresh.requestedNonce,
				null,
			);
			logger.debug("library", "Cached", {
				account: this.#record.accountName,
				games: games.length,
			});
		} catch (error) {
			if (this.#isCurrent(generation, client)) {
				const message = error instanceof Error ? error.message : String(error);
				this.store.completeLibraryRefresh(
					accountId,
					refresh.requestedNonce,
					message,
				);
				logger.warn("library", "Refresh failed; using existing cache", {
					account: this.#record.accountName,
					error: message,
				});
			}
		} finally {
			if (this.#librarySyncGeneration === generation) {
				this.#librarySyncGeneration = null;
			}
		}
	}

	#fail(error: SteamError, needsAuthentication: boolean): void {
		const account = this.#record;
		const loggedInElsewhere = isLoggedInElsewhere(error);
		const earlyRetryProtected = Date.now() < this.#earlyRetryProtectionUntil;
		this.#disconnect(loggedInElsewhere);
		this.#connecting = false;
		if (needsAuthentication) {
			this.#retryAt = Number.POSITIVE_INFINITY;
			this.#gameExitWait = null;
			this.#earlyRetryProtectionUntil = 0;
			this.#record = this.store.updateRuntime(account.id, {
				status: "needs_auth",
				lastError: error.message,
			});
			this.#publishCurrentActivity();
			logger.error("steam", "Reauthentication required", {
				account: account.accountName,
				error: error.message,
			});
			return;
		}

		if (!account.autoRestart) {
			this.#retryAt = Number.POSITIVE_INFINITY;
			this.#gameExitWait = null;
			this.#earlyRetryProtectionUntil = 0;
			this.#webCookies = null;
			this.#record = this.store.updateRuntime(account.id, {
				status: "error",
				lastError: error.message,
			});
			this.#publishCurrentActivity();
			logger.warn("steam", "Disconnected; automatic restart disabled", {
				account: account.accountName,
				error: error.message,
			});
			return;
		}

		if (loggedInElsewhere && this.#webCookies && !earlyRetryProtected) {
			this.#retryAt = Number.POSITIVE_INFINITY;
			this.#earlyRetryProtectionUntil = 0;
			this.#gameExitWait = {
				nextCheckAt: 0,
				checkInFlight: false,
				lastStatus: null,
				consecutiveMatches: 0,
			};
			this.#record = this.store.updateRuntime(account.id, {
				status: "backoff",
				lastError: error.message,
			});
			this.#publishCurrentActivity();
			logger.warn("steam", "Disconnected; waiting for game exit", {
				account: account.accountName,
				error: error.message,
				poll: "30s",
			});
			return;
		}

		this.#gameExitWait = null;
		this.#earlyRetryProtectionUntil = 0;
		const delay = loggedInElsewhere
			? LOGGED_IN_ELSEWHERE_RETRY_MS
			: Math.min(MAX_RETRY_MS, INITIAL_RETRY_MS * 2 ** this.#retryAttempt);
		this.#retryAttempt += 1;
		this.#retryAt = Date.now() + delay;
		this.#record = this.store.updateRuntime(account.id, {
			status: "backoff",
			lastError: error.message,
		});
		this.#publishCurrentActivity();
		logger.warn("steam", "Disconnected; retry scheduled", {
			account: account.accountName,
			error: error.message,
			retry: `${Math.ceil(delay / 1_000)}s`,
		});
	}

	async #checkProfileStatus(): Promise<void> {
		const wait = this.#gameExitWait;
		const cookies = this.#webCookies;
		if (
			!wait ||
			!cookies ||
			wait.checkInFlight ||
			Date.now() < wait.nextCheckAt
		) {
			return;
		}

		wait.checkInFlight = true;
		wait.nextCheckAt = Date.now() + PROFILE_STATUS_POLL_INTERVAL_MS;
		this.#publishCurrentActivity();
		try {
			const status =
				await this.communityProfileStatus.getProfileStatus(cookies);
			if (this.#gameExitWait !== wait || this.#stopped) {
				return;
			}
			const assessment = assessProfileStatus(
				status,
				wait.lastStatus,
				wait.consecutiveMatches,
			);
			if (assessment.action === "wait") {
				wait.lastStatus = assessment.lastStatus;
				wait.consecutiveMatches = assessment.consecutiveMatches;
				this.#publishCurrentActivity();
				return;
			}
			if (assessment.action === "fallback") {
				this.#scheduleProfileStatusFallback("unrecognized-profile-status");
				return;
			}
			this.#gameExitWait = null;
			this.#retryAt = 0;
			this.#earlyRetryProtectionUntil = Number.POSITIVE_INFINITY;
			logger.info(
				"steam",
				assessment.mode === "confirmed-exit"
					? "Game exit confirmed; reconnecting early"
					: "Profile remained offline; probing reconnect",
				{
					account: this.#record.accountName,
				},
			);
		} catch (error) {
			if (this.#gameExitWait !== wait || this.#stopped) {
				return;
			}
			if (error instanceof SteamCommunityAuthenticationError) {
				this.#webCookies = null;
			}
			this.#scheduleProfileStatusFallback(
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			wait.checkInFlight = false;
		}
	}

	#scheduleProfileStatusFallback(reason: string): void {
		this.#gameExitWait = null;
		this.#earlyRetryProtectionUntil = 0;
		this.#retryAt = Date.now() + LOGGED_IN_ELSEWHERE_RETRY_MS;
		this.#publishCurrentActivity();
		logger.warn("steam", "Profile status unavailable; using fixed retry", {
			account: this.#record.accountName,
			reason,
			retry: "45m",
		});
	}

	#disconnect(preserveWebSession = false): void {
		const client = this.#client;
		this.#generation += 1;
		this.#presenceOperation += 1;
		this.#resetAutoStopMonitoring();
		this.#client = null;
		this.#presence?.dispose();
		this.#presence = null;
		this.#cardFarming?.dispose();
		this.#cardFarming = null;
		this.#appliedPresenceMode = null;
		this.#autoStopTargetsSuppressed = false;
		this.#sessionStartedAt = null;
		this.#connecting = false;
		if (!preserveWebSession) {
			this.#webCookies = null;
			this.#externalAppId = null;
		}
		if (client) {
			client.removeAllListeners();
			client.logOff();
		}
	}

	#stopHourBoosting(next: "card-farming" | "disabled"): void {
		if (this.#appliedPresenceMode !== "hour-boosting") {
			return;
		}
		logger.info("presence", "Hour boosting stopped", {
			account: this.#record.accountName,
			next,
		});
		this.#appliedPresenceMode = null;
	}

	#publishCurrentActivity(): void {
		const activity = this.#currentActivity();
		const identity = this.#activityIdentity(activity);
		if (identity !== this.#lastActivityIdentity) {
			this.#lastActivityIdentity = identity;
			this.#activitySince = new Date().toISOString();
		}
		try {
			this.store.writeRuntimeSnapshot(this.#record.id, this.runnerOwnerId, {
				version: 1,
				activity,
				activitySince: this.#activitySince,
				sessionStartedAt: this.#sessionStartedAt,
				externalAppId: this.#externalAppId,
			});
			this.#runtimeSnapshotPublished = true;
			this.#runtimePublishErrorLogged = false;
		} catch (error) {
			this.#runtimeSnapshotPublished = false;
			if (!this.#runtimePublishErrorLogged) {
				this.#runtimePublishErrorLogged = true;
				logger.warn("runner", "Could not publish account runtime status", {
					account: this.#record.accountName,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	#activityIdentity(activity: RuntimeActivity): string {
		switch (activity.kind) {
			case "connecting":
				return `${activity.kind}:${activity.attempt}`;
			case "boosting":
				return `${activity.kind}:${activity.appIds.join(",")}:${activity.customGame ?? ""}`;
			case "farming":
				return `${activity.kind}:${activity.appId ?? "scan"}`;
			case "waiting_external_game":
				return `${activity.kind}:${activity.externalAppId ?? "unknown"}`;
			case "retrying":
				return `${activity.kind}:${activity.attempt}:${activity.retryAt}`;
			default:
				return activity.kind;
		}
	}

	#currentActivity(): RuntimeActivity {
		if (!this.#record.enabled) {
			return { kind: "disabled" };
		}
		if (this.#record.status === "needs_auth") {
			return { kind: "needs_auth" };
		}
		if (this.#record.status === "error") {
			return { kind: "error" };
		}
		if (this.#connecting) {
			return { kind: "connecting", attempt: this.#retryAttempt + 1 };
		}
		if (this.#gameExitWait) {
			return {
				kind: "waiting_external_game",
				externalAppId: this.#externalAppId,
				nextCheckAt: this.#timestamp(this.#gameExitWait.nextCheckAt),
			};
		}
		if (!this.#client && Number.isFinite(this.#retryAt) && this.#retryAt > 0) {
			return {
				kind: "retrying",
				attempt: Math.max(1, this.#retryAttempt),
				retryAt: new Date(this.#retryAt).toISOString(),
			};
		}
		if (this.#externalAppId !== null) {
			return {
				kind: "waiting_external_game",
				externalAppId: this.#externalAppId,
				nextCheckAt: null,
			};
		}
		if (this.#record.cardFarmingEnabled && this.#client) {
			const active = this.#record.cardFarmingQueue[0];
			return {
				kind: "farming",
				appId: active?.appId ?? null,
				remainingDrops: active?.remainingDrops ?? null,
				queueLength: this.#record.cardFarmingQueue.length,
				nextCheckAt: this.#timestamp(this.#cardFarming?.nextCheckAt ?? null),
			};
		}
		if (this.#appliedPresenceMode === "hour-boosting") {
			return {
				kind: "boosting",
				appIds: [...this.#record.appIds],
				customGame: this.#record.customGame,
				autoStop: this.#autoStopProgress,
			};
		}
		return { kind: "idle" };
	}

	#timestamp(value: number | null): string | null {
		return value !== null && Number.isFinite(value) && value > 0
			? new Date(value).toISOString()
			: null;
	}

	#isCurrent(generation: number, client: SteamUser): boolean {
		return (
			!this.#stopped &&
			generation === this.#generation &&
			client === this.#client
		);
	}
}
