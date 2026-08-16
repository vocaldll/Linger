import SteamUser from "steam-user";
import type { CredentialVault } from "../crypto.js";
import type { AccountStore } from "../database.js";
import type { Account } from "../domain/account.js";
import { logger } from "../logger.js";
import { CardFarmingController } from "./card-farming.js";
import {
	type CommunityProfileStatus,
	type ProfileStatus,
	SteamCommunityAuthenticationError,
	SteamCommunityCardService,
} from "./community-cards.js";
import { getOwnedGames } from "./game-library.js";
import { PresenceController } from "./presence.js";

const INITIAL_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60 * 1_000;
const LOGGED_IN_ELSEWHERE_RETRY_MS = 45 * 60 * 1_000;
const PROFILE_STATUS_POLL_INTERVAL_MS = 30_000;
const PROFILE_STATUS_CONFIRMATIONS_REQUIRED = 2;
const EARLY_RETRY_STABILITY_MS = 30_000;

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

function presenceChanged(previous: Account, next: Account): boolean {
	return (
		previous.visible !== next.visible ||
		previous.clearRecentActivity !== next.clearRecentActivity ||
		previous.cardFarmingEnabled !== next.cardFarmingEnabled ||
		previous.cardFarmingQueue[0]?.appId !== next.cardFarmingQueue[0]?.appId ||
		previous.customGame !== next.customGame ||
		JSON.stringify(previous.appIds) !== JSON.stringify(next.appIds)
	);
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

	constructor(
		private readonly store: AccountStore,
		private readonly vault: CredentialVault,
		account: Account,
		private readonly communityProfileStatus: CommunityProfileStatus = new SteamCommunityCardService(),
	) {
		this.#record = account;
		if (account.status === "needs_auth") {
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
		this.#record = next;
		this.#cardFarming?.reconcile(next);

		if (!next.enabled) {
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
			return;
		}

		if (credentialsChanged || restartRequested) {
			this.#disconnect();
			this.#retryAt = 0;
			this.#retryAttempt = 0;
			this.#gameExitWait = null;
			this.#earlyRetryProtectionUntil = 0;
		} else if (this.#client && presenceChanged(previous, next)) {
			this.#applyPresence();
		}
		if (this.#client) {
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
	}

	stop(): void {
		this.#stopped = true;
		this.#disconnect();
		if (this.store.get(this.#record.id)?.enabled) {
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
			return;
		}

		const client = new SteamUser({
			autoRelogin: false,
			renewRefreshTokens: true,
			dataDirectory: null,
			enablePicsCache: false,
		});
		guardWebLogOnAfterDisconnect(client);
		this.#client = client;
		this.#record = this.store.updateRuntime(account.id, {
			status: "connecting",
			lastError: null,
		});
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
				machineName: "Linger",
			});
		} catch (error) {
			this.#fail(
				error instanceof Error ? error : new Error(String(error)),
				false,
			);
		}
	}

	#applyPresence(): void {
		const presence = this.#presence;
		if (!presence) {
			return;
		}
		const snapshot = this.#record;
		const intent =
			!snapshot.enabled || snapshot.cardFarmingEnabled
				? {
						mode: "farm" as const,
						appId: snapshot.enabled
							? (snapshot.cardFarmingQueue[0]?.appId ?? null)
							: null,
						visible: snapshot.visible,
					}
				: { mode: "boost" as const, configuration: snapshot };
		void presence.apply(intent).then(
			(applied) => {
				if (!applied || presence !== this.#presence) {
					return;
				}
				if (!snapshot.enabled) {
					this.#appliedPresenceMode = null;
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
							...(snapshot.customGame
								? { customGame: snapshot.customGame }
								: {}),
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
				const label =
					mode === "card-farming" ? "Card farming" : "Hour boosting";
				const action =
					this.#appliedPresenceMode === mode ? "updated" : "started";
				logger.info("presence", `${label} ${action}`, fields);
				this.#appliedPresenceMode = mode;
			},
			(error: unknown) => {
				logger.error("presence", "Could not apply", {
					account: snapshot.accountName,
					error: error instanceof Error ? error.message : String(error),
				});
			},
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
			const games = await getOwnedGames(client, steamId);
			if (!this.#isCurrent(generation, client)) {
				return;
			}
			this.store.replaceOwnedGames(accountId, games);
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
			logger.error("steam", "Reauthentication required", {
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
		logger.warn("steam", "Profile status unavailable; using fixed retry", {
			account: this.#record.accountName,
			reason,
			retry: "45m",
		});
	}

	#disconnect(preserveWebSession = false): void {
		const client = this.#client;
		this.#generation += 1;
		this.#client = null;
		this.#presence?.dispose();
		this.#presence = null;
		this.#cardFarming?.dispose();
		this.#cardFarming = null;
		this.#appliedPresenceMode = null;
		this.#connecting = false;
		if (!preserveWebSession) {
			this.#webCookies = null;
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

	#isCurrent(generation: number, client: SteamUser): boolean {
		return (
			!this.#stopped &&
			generation === this.#generation &&
			client === this.#client
		);
	}
}
