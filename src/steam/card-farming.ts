import type { AccountStore } from "../database.js";
import type { Account } from "../domain/account.js";
import { buildCardFarmingQueue } from "../domain/card-farming.js";
import { logger } from "../logger.js";
import {
	type CardCommunity,
	SteamCommunityAuthenticationError,
	SteamCommunityCardService,
} from "./community-cards.js";

const REGULAR_CHECK_INTERVAL_MS = 15 * 60 * 1_000;
const RETRY_INTERVAL_MS = 2 * 60 * 1_000;
const ITEM_EVENT_DEBOUNCE_MS = 5_000;

type CardFarmingStore = Pick<
	AccountStore,
	| "get"
	| "listOwnedGames"
	| "replaceCardFarmingQueue"
	| "finishCardFarming"
	| "getCardFarmingScanState"
	| "completeCardFarmingScan"
>;

type CardFarmingCallbacks = {
	accountChanged(account: Account): void;
	applyPresence(account: Account): void;
	refreshWebSession(): void;
	stateChanged(): void;
};

export class CardFarmingController {
	#record: Account;
	#cookies: string[] | null = null;
	#timer: NodeJS.Timeout | null = null;
	#inFlight = false;
	#checkRequested = false;
	#disposed = false;
	#activityAnnounced = false;
	#nextCheckAt: number | null = null;
	#scanInFlight = false;

	constructor(
		private readonly store: CardFarmingStore,
		account: Account,
		private readonly callbacks: CardFarmingCallbacks,
		private readonly community: CardCommunity = new SteamCommunityCardService(),
	) {
		this.#record = account;
	}

	get nextCheckAt(): number | null {
		return this.#nextCheckAt;
	}

	reconcile(account: Account): void {
		const wasActive = this.#record.enabled && this.#record.cardFarmingEnabled;
		const previousAppId = this.#record.cardFarmingQueue[0]?.appId;
		const stopped =
			wasActive && (!account.enabled || !account.cardFarmingEnabled);
		this.#record = account;
		this.#scanIfRequested();
		if (!account.enabled || !account.cardFarmingEnabled) {
			const scheduleChanged = this.#cancelTimer();
			if (scheduleChanged) {
				this.callbacks.stateChanged();
			}
			this.#activityAnnounced = false;
			if (stopped) {
				logger.info("cards", "Farming stopped", {
					account: account.accountName,
					next: account.enabled ? "hour-boosting" : "disabled",
				});
			}
			return;
		}
		const activeAppChanged =
			previousAppId !== account.cardFarmingQueue[0]?.appId;
		if (
			this.#cookies &&
			(!wasActive || activeAppChanged || (!this.#timer && !this.#inFlight))
		) {
			this.#announceResume();
			this.#schedule(0);
		}
	}

	setWebSession(cookies: readonly string[]): void {
		this.#cookies = [...cookies];
		this.#scanIfRequested();
		if (this.#record.enabled && this.#record.cardFarmingEnabled) {
			this.#announceResume();
			this.#schedule(0);
		}
	}

	notifyNewItems(): void {
		if (
			this.#record.enabled &&
			this.#record.cardFarmingEnabled &&
			this.#cookies
		) {
			this.#schedule(ITEM_EVENT_DEBOUNCE_MS);
		}
	}

	async checkNow(): Promise<void> {
		if (
			this.#disposed ||
			!this.#cookies ||
			!this.#record.enabled ||
			!this.#record.cardFarmingEnabled
		) {
			return;
		}
		if (this.#inFlight) {
			this.#checkRequested = true;
			return;
		}

		this.#cancelTimer();
		this.callbacks.stateChanged();
		this.#inFlight = true;
		try {
			await this.#check();
		} catch (error) {
			if (this.#disposed) {
				return;
			}
			if (error instanceof SteamCommunityAuthenticationError) {
				this.#cookies = null;
				logger.warn("cards", "Community session expired; refreshing", {
					account: this.#record.accountName,
				});
				this.callbacks.refreshWebSession();
			} else {
				logger.warn("cards", "Progress check failed; retry scheduled", {
					account: this.#record.accountName,
					error: error instanceof Error ? error.message : String(error),
					retry: "2m",
				});
				this.#schedule(RETRY_INTERVAL_MS);
			}
		} finally {
			this.#inFlight = false;
			if (this.#checkRequested && !this.#disposed) {
				this.#checkRequested = false;
				this.#schedule(0);
			}
		}
	}

	dispose(): void {
		this.#disposed = true;
		this.#cookies = null;
		if (this.#cancelTimer()) {
			this.callbacks.stateChanged();
		}
	}

	async #check(): Promise<void> {
		const cookies = this.#cookies;
		if (!cookies) {
			return;
		}
		const latest = this.store.get(this.#record.id);
		if (!latest?.enabled || !latest.cardFarmingEnabled) {
			return;
		}
		this.#record = latest;

		if (latest.cardFarmingQueue.length === 0) {
			const discovered = await this.community.discoverFarmableGames(cookies);
			const current = this.store.get(latest.id);
			if (
				!current?.enabled ||
				!current.cardFarmingEnabled ||
				current.cardFarmingQueue.length > 0
			) {
				return;
			}
			const queue = buildCardFarmingQueue(
				discovered,
				current.cardFarmingExclusions,
				current.cardFarmingPolicy,
				this.store.listOwnedGames(current.id),
			);
			const firstDiscovered = queue[0];
			if (firstDiscovered === undefined) {
				this.#finish(current);
				return;
			}

			const updated = this.store.replaceCardFarmingQueue(current.id, queue);
			this.#publish(updated);
			this.#activityAnnounced = true;
			logger.info("cards", "Farming started", {
				account: updated.accountName,
				...this.#gameFields(firstDiscovered.appId),
				drops: firstDiscovered.remainingDrops,
				queued: queue.length,
			});
			this.callbacks.applyPresence(updated);
			this.#schedule(REGULAR_CHECK_INTERVAL_MS);
			return;
		}

		const active = latest.cardFarmingQueue[0];
		if (active === undefined) {
			return;
		}
		const remainingDrops = await this.community.getRemainingDrops(
			cookies,
			active.appId,
		);
		const current = this.store.get(latest.id);
		if (
			!current?.enabled ||
			!current.cardFarmingEnabled ||
			current.cardFarmingQueue[0]?.appId !== active.appId
		) {
			return;
		}

		if (remainingDrops > 0) {
			if (remainingDrops !== active.remainingDrops) {
				const queue = [
					{ appId: active.appId, remainingDrops },
					...current.cardFarmingQueue.slice(1),
				];
				const updated = this.store.replaceCardFarmingQueue(current.id, queue);
				this.#publish(updated);
				logger.info("cards", "Drop count updated", {
					account: updated.accountName,
					...this.#gameFields(active.appId),
					drops: remainingDrops,
				});
			}
			this.#schedule(REGULAR_CHECK_INTERVAL_MS);
			return;
		}

		let nextQueue = current.cardFarmingQueue.slice(1);
		if (current.cardFarmingRescan) {
			const discovered = await this.community.discoverFarmableGames(cookies);
			const rescanned = this.store.get(current.id);
			if (
				!rescanned?.enabled ||
				!rescanned.cardFarmingEnabled ||
				rescanned.cardFarmingQueue[0]?.appId !== active.appId
			) {
				return;
			}
			nextQueue = buildCardFarmingQueue(
				discovered,
				rescanned.cardFarmingExclusions,
				rescanned.cardFarmingPolicy,
				this.store.listOwnedGames(rescanned.id),
				rescanned.cardFarmingQueue.slice(1).map((entry) => entry.appId),
				[active.appId],
			);
		}
		const next = nextQueue[0];
		if (next === undefined) {
			logger.info("cards", "Game complete", {
				account: current.accountName,
				...this.#gameFields(active.appId),
				queued: 0,
			});
			this.#finish(current);
			return;
		}

		const updated = this.store.replaceCardFarmingQueue(current.id, nextQueue);
		this.#publish(updated);
		logger.info("cards", "Next game", {
			account: updated.accountName,
			completedApp: active.appId,
			...this.#gameFields(next.appId),
			drops: next.remainingDrops,
			queued: nextQueue.length,
		});
		this.callbacks.applyPresence(updated);
		this.#schedule(REGULAR_CHECK_INTERVAL_MS);
	}

	#finish(account: Account): void {
		const updated = this.store.finishCardFarming(account.id);
		this.#publish(updated);
		this.callbacks.applyPresence(updated);
		logger.info("cards", "Farming complete", {
			account: updated.accountName,
			next: updated.enabled ? "hour-boosting" : "disabled",
		});
	}

	#publish(account: Account): void {
		this.#record = account;
		this.callbacks.accountChanged(account);
	}

	#gameFields(appId: number): { game?: string; app: number } {
		const game = this.store
			.listOwnedGames(this.#record.id)
			.find((candidate) => candidate.appId === appId);
		return { ...(game ? { game: game.name } : {}), app: appId };
	}

	#announceResume(): void {
		const active = this.#record.cardFarmingQueue[0];
		if (this.#activityAnnounced || !active) {
			return;
		}
		this.#activityAnnounced = true;
		logger.info("cards", "Farming resumed", {
			account: this.#record.accountName,
			...this.#gameFields(active.appId),
			drops: active.remainingDrops,
			queued: this.#record.cardFarmingQueue.length,
		});
	}

	#scanIfRequested(): void {
		if (this.#disposed || this.#scanInFlight || !this.#cookies) {
			return;
		}
		const scan = this.store.getCardFarmingScanState(this.#record.id);
		if (scan.requestedNonce <= scan.completedNonce) {
			return;
		}
		this.#scanInFlight = true;
		void this.#completeScan(scan.requestedNonce);
	}

	async #completeScan(requestedNonce: number): Promise<void> {
		try {
			const cookies = this.#cookies;
			if (!cookies) {
				return;
			}
			const discovered = await this.community.discoverFarmableGames(cookies);
			if (!this.#disposed) {
				this.store.completeCardFarmingScan(
					this.#record.id,
					requestedNonce,
					discovered,
					null,
				);
			}
		} catch (error) {
			if (!this.#disposed) {
				const message = error instanceof Error ? error.message : String(error);
				this.store.completeCardFarmingScan(
					this.#record.id,
					requestedNonce,
					[],
					message,
				);
				if (error instanceof SteamCommunityAuthenticationError) {
					this.#cookies = null;
					this.callbacks.refreshWebSession();
				}
			}
		} finally {
			this.#scanInFlight = false;
			if (!this.#disposed) {
				this.#scanIfRequested();
			}
		}
	}

	#schedule(delay: number): void {
		if (
			this.#disposed ||
			!this.#cookies ||
			!this.#record.enabled ||
			!this.#record.cardFarmingEnabled
		) {
			return;
		}
		this.#cancelTimer();
		this.#nextCheckAt = Date.now() + delay;
		this.#timer = setTimeout(() => {
			this.#timer = null;
			this.#nextCheckAt = null;
			void this.checkNow();
		}, delay);
		this.#timer.unref();
		this.callbacks.stateChanged();
	}

	#cancelTimer(): boolean {
		const changed = this.#timer !== null || this.#nextCheckAt !== null;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
		this.#nextCheckAt = null;
		return changed;
	}
}
