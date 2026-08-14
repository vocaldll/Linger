import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { AccountStore } from "../src/database.js";
import type { Account, CardFarmingEntry } from "../src/domain/account.js";
import { CardFarmingController } from "../src/steam/card-farming.js";
import type { CardCommunity } from "../src/steam/community-cards.js";

const temporaryDirectories: string[] = [];
const controllers: CardFarmingController[] = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) {
    controller.dispose();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): AccountStore {
  const directory = mkdtempSync(path.join(tmpdir(), "linger-farming-test-"));
  temporaryDirectories.push(directory);
  return new AccountStore(path.join(directory, "linger.sqlite"));
}

function createAccount(store: AccountStore, appIds: number[]): Account {
  return store.create({
    accountName: "farmer",
    steamId: "76561198000000000",
    refreshTokenEncrypted: "encrypted",
    machineAuthTokenEncrypted: null,
    appIds,
    customGame: null,
    visible: false,
    clearRecentActivity: false,
    cardFarmingEnabled: true,
    enabled: true
  });
}

class FakeCommunity implements CardCommunity {
  readonly remaining = new Map<number, number>();
  discoveryCalls = 0;
  remainingCalls = 0;

  constructor(readonly discovered: CardFarmingEntry[]) {}

  async discoverFarmableGames(): Promise<CardFarmingEntry[]> {
    this.discoveryCalls += 1;
    return this.discovered;
  }

  async getRemainingDrops(_cookies: readonly string[], appId: number): Promise<number> {
    this.remainingCalls += 1;
    return this.remaining.get(appId) ?? 0;
  }
}

function createController(
  store: AccountStore,
  account: Account,
  community: CardCommunity,
  applied: Account[]
): CardFarmingController {
  const controller = new CardFarmingController(
    store,
    account,
    {
      accountChanged() {},
      applyPresence(updated) {
        applied.push(updated);
      },
      refreshWebSession() {}
    },
    community
  );
  controllers.push(controller);
  controller.setWebSession(["session=secret"]);
  return controller;
}

describe("card farming controller", () => {
  it("farms a persisted queue and restores hour boosting when it is exhausted", async () => {
    const store = createStore();
    const account = createAccount(store, [730]);
    const community = new FakeCommunity([
      { appId: 440, remainingDrops: 2 },
      { appId: 570, remainingDrops: 1 }
    ]);
    const applied: Account[] = [];
    const controller = createController(store, account, community, applied);

    await controller.checkNow();
    assert.deepEqual(store.get(account.id)?.cardFarmingQueue, community.discovered);
    controller.reconcile(store.get(account.id)!);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(community.remainingCalls, 0);

    community.remaining.set(440, 0);
    await controller.checkNow();
    assert.equal(store.get(account.id)?.cardFarmingQueue[0]?.appId, 570);

    community.remaining.set(570, 0);
    await controller.checkNow();
    const finished = store.get(account.id)!;
    assert.equal(finished.cardFarmingEnabled, false);
    assert.equal(finished.enabled, true);
    assert.deepEqual(finished.cardFarmingQueue, []);
    assert.equal(applied.at(-1)?.cardFarmingEnabled, false);
    store.close();
  });

  it("disables an account with no fallback presence when nothing is farmable", async () => {
    const store = createStore();
    const account = createAccount(store, []);
    const controller = createController(store, account, new FakeCommunity([]), []);

    await controller.checkNow();
    const finished = store.get(account.id)!;
    assert.equal(finished.cardFarmingEnabled, false);
    assert.equal(finished.enabled, false);
    assert.equal(finished.status, "disabled");
    store.close();
  });

  it("keeps farming enabled when discovery fails", async () => {
    const store = createStore();
    const account = createAccount(store, []);
    const failingCommunity: CardCommunity = {
      async discoverFarmableGames() {
        throw new Error("unrecognized badges page");
      },
      async getRemainingDrops() {
        throw new Error("not reached");
      }
    };
    const controller = createController(store, account, failingCommunity, []);

    await controller.checkNow();
    const unchanged = store.get(account.id)!;
    assert.equal(unchanged.cardFarmingEnabled, true);
    assert.equal(unchanged.enabled, true);
    assert.deepEqual(unchanged.cardFarmingQueue, []);
    store.close();
  });
});
