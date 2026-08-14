import type { Account } from "../domain/account.js";
import type { AccountStore } from "../database.js";
import { logger } from "../logger.js";
import {
  SteamCommunityAuthenticationError,
  SteamCommunityCardService,
  type CardCommunity
} from "./community-cards.js";

const REGULAR_CHECK_INTERVAL_MS = 15 * 60 * 1_000;
const RETRY_INTERVAL_MS = 2 * 60 * 1_000;
const ITEM_EVENT_DEBOUNCE_MS = 5_000;

type CardFarmingStore = Pick<
  AccountStore,
  "get" | "replaceCardFarmingQueue" | "finishCardFarming"
>;

type CardFarmingCallbacks = {
  accountChanged(account: Account): void;
  applyPresence(account: Account): void;
  refreshWebSession(): void;
};

export class CardFarmingController {
  #record: Account;
  #cookies: string[] | null = null;
  #timer: NodeJS.Timeout | null = null;
  #inFlight = false;
  #checkRequested = false;
  #disposed = false;

  constructor(
    private readonly store: CardFarmingStore,
    account: Account,
    private readonly callbacks: CardFarmingCallbacks,
    private readonly community: CardCommunity = new SteamCommunityCardService()
  ) {
    this.#record = account;
  }

  reconcile(account: Account): void {
    const wasActive = this.#record.enabled && this.#record.cardFarmingEnabled;
    const previousAppId = this.#record.cardFarmingQueue[0]?.appId;
    this.#record = account;
    if (!account.enabled || !account.cardFarmingEnabled) {
      this.#cancelTimer();
      return;
    }
    const activeAppChanged = previousAppId !== account.cardFarmingQueue[0]?.appId;
    if (this.#cookies && (!wasActive || activeAppChanged || (!this.#timer && !this.#inFlight))) {
      this.#schedule(0);
    }
  }

  setWebSession(cookies: readonly string[]): void {
    this.#cookies = [...cookies];
    if (this.#record.enabled && this.#record.cardFarmingEnabled) {
      this.#schedule(0);
    }
  }

  notifyNewItems(): void {
    if (this.#record.enabled && this.#record.cardFarmingEnabled && this.#cookies) {
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
    this.#inFlight = true;
    try {
      await this.#check();
    } catch (error) {
      if (this.#disposed) {
        return;
      }
      if (error instanceof SteamCommunityAuthenticationError) {
        this.#cookies = null;
        logger.warn("Steam Community session expired while card farming; refreshing it", {
          account: this.#record.accountName
        });
        this.callbacks.refreshWebSession();
      } else {
        logger.warn("Could not check Steam card farming progress; will retry", {
          account: this.#record.accountName,
          error: error instanceof Error ? error.message : String(error)
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
    this.#cancelTimer();
  }

  async #check(): Promise<void> {
    const cookies = this.#cookies;
    if (!cookies) {
      return;
    }
    const latest = this.store.get(this.#record.id);
    if (!latest || !latest.enabled || !latest.cardFarmingEnabled) {
      return;
    }
    this.#record = latest;

    if (latest.cardFarmingQueue.length === 0) {
      const discovered = await this.community.discoverFarmableGames(cookies);
      const current = this.store.get(latest.id);
      if (
        !current ||
        !current.enabled ||
        !current.cardFarmingEnabled ||
        current.cardFarmingQueue.length > 0
      ) {
        return;
      }
      if (discovered.length === 0) {
        this.#finish(current);
        return;
      }

      const updated = this.store.replaceCardFarmingQueue(current.id, discovered);
      this.#publish(updated);
      logger.info("Started Steam card farming", {
        account: updated.accountName,
        appId: discovered[0]!.appId,
        remainingDrops: discovered[0]!.remainingDrops,
        queuedGames: discovered.length
      });
      this.callbacks.applyPresence(updated);
      this.#schedule(REGULAR_CHECK_INTERVAL_MS);
      return;
    }

    const active = latest.cardFarmingQueue[0]!;
    const remainingDrops = await this.community.getRemainingDrops(cookies, active.appId);
    const current = this.store.get(latest.id);
    if (
      !current ||
      !current.enabled ||
      !current.cardFarmingEnabled ||
      current.cardFarmingQueue[0]?.appId !== active.appId
    ) {
      return;
    }

    if (remainingDrops > 0) {
      if (remainingDrops !== active.remainingDrops) {
        const queue = [
          { appId: active.appId, remainingDrops },
          ...current.cardFarmingQueue.slice(1)
        ];
        const updated = this.store.replaceCardFarmingQueue(current.id, queue);
        this.#publish(updated);
        logger.info("Steam card farming progressed", {
          account: updated.accountName,
          appId: active.appId,
          remainingDrops
        });
      }
      this.#schedule(REGULAR_CHECK_INTERVAL_MS);
      return;
    }

    const nextQueue = current.cardFarmingQueue.slice(1);
    if (nextQueue.length === 0) {
      logger.info("Finished farming Steam cards for a game", {
        account: current.accountName,
        appId: active.appId,
        queuedGames: 0
      });
      this.#finish(current);
      return;
    }

    const updated = this.store.replaceCardFarmingQueue(current.id, nextQueue);
    this.#publish(updated);
    logger.info("Finished farming Steam cards; moving to the next game", {
      account: updated.accountName,
      finishedAppId: active.appId,
      appId: nextQueue[0]!.appId,
      remainingDrops: nextQueue[0]!.remainingDrops,
      queuedGames: nextQueue.length
    });
    this.callbacks.applyPresence(updated);
    this.#schedule(REGULAR_CHECK_INTERVAL_MS);
  }

  #finish(account: Account): void {
    const updated = this.store.finishCardFarming(account.id);
    this.#publish(updated);
    this.callbacks.applyPresence(updated);
    logger.info("Steam card farming completed", {
      account: updated.accountName,
      hourBoostingResumed: updated.enabled,
      accountDisabled: !updated.enabled
    });
  }

  #publish(account: Account): void {
    this.#record = account;
    this.callbacks.accountChanged(account);
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
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.checkNow();
    }, delay);
    this.#timer.unref();
  }

  #cancelTimer(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
