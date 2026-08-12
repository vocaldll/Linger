import { randomUUID } from "node:crypto";
import { CredentialVault } from "./crypto.js";
import { AccountStore } from "./database.js";
import { logger } from "./logger.js";
import { AccountWorker } from "./steam/account-worker.js";

export class Runner {
  readonly #workers = new Map<string, AccountWorker>();
  readonly #ownerId = randomUUID();
  #running = false;
  #wake: (() => void) | null = null;
  #runPromise: Promise<void> | null = null;

  constructor(
    private readonly store: AccountStore,
    private readonly vault: CredentialVault,
    private readonly reconcileIntervalMs: number
  ) {}

  async start(): Promise<void> {
    if (this.#runPromise) {
      throw new Error("Linger runner is already started in this process");
    }
    if (!this.store.claimRunner(this.#ownerId)) {
      throw new Error("Another Linger runner is already using this database");
    }

    this.store.resetInterruptedStatuses();
    this.#running = true;
    this.#runPromise = this.#run();
    try {
      await this.#runPromise;
    } finally {
      this.#runPromise = null;
    }
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#wake?.();
    await this.#runPromise;
  }

  async #run(): Promise<void> {
    logger.info("Linger runner started");
    try {
      while (this.#running) {
        this.store.heartbeatRunner(this.#ownerId);
        this.#reconcile();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.reconcileIntervalMs);
          this.#wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.#wake = null;
      }
    } finally {
      for (const worker of this.#workers.values()) {
        try {
          worker.stop();
        } catch (error) {
          logger.error("Could not stop Steam account cleanly", {
            account: worker.accountName,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      this.#workers.clear();
      this.store.releaseRunner(this.#ownerId);
      logger.info("Linger runner stopped");
    }
  }

  #reconcile(): void {
    const accounts = this.store.list();
    const existingIds = new Set(accounts.map((account) => account.id));

    for (const [id, worker] of this.#workers) {
      if (!existingIds.has(id)) {
        try {
          worker.stop();
        } catch (error) {
          logger.error("Could not stop removed Steam account cleanly", {
            account: worker.accountName,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        this.#workers.delete(id);
      }
    }

    for (const account of accounts) {
      let worker = this.#workers.get(account.id);
      if (!worker) {
        worker = new AccountWorker(this.store, this.vault, account);
        this.#workers.set(account.id, worker);
      }
      try {
        worker.reconcile(account);
      } catch (error) {
        logger.error("Could not reconcile Steam account", {
          account: account.accountName,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
}
