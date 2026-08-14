import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { AccountStore } from "../src/database.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): AccountStore {
  const directory = mkdtempSync(path.join(tmpdir(), "linger-test-"));
  temporaryDirectories.push(directory);
  return new AccountStore(path.join(directory, "linger.sqlite"));
}

describe("AccountStore", () => {
  it("creates and reconfigures an account", () => {
    const store = createStore();
    const account = store.create({
      accountName: "vocal",
      steamId: "76561198000000000",
      refreshTokenEncrypted: "encrypted",
      machineAuthTokenEncrypted: null,
      appIds: [730],
      customGame: null,
      visible: true,
      clearRecentActivity: false,
      cardFarmingEnabled: false,
      enabled: true
    });

    assert.equal(store.getByName("VOCAL")?.id, account.id);
    const updated = store.updateConfiguration(account.id, {
      appIds: [440, 570],
      customGame: "Linger",
      visible: false,
      clearRecentActivity: true
    });
    assert.deepEqual(updated.appIds, [440, 570]);
    assert.equal(updated.customGame, "Linger");
    assert.equal(updated.visible, false);
    assert.equal(updated.clearRecentActivity, true);
    assert.equal(updated.revision, account.revision + 1);
    store.close();
  });

  it("supports runtime updates without changing configuration revision", () => {
    const store = createStore();
    const account = store.create({
      accountName: "runtime-test",
      steamId: null,
      refreshTokenEncrypted: "encrypted",
      machineAuthTokenEncrypted: null,
      appIds: [730],
      customGame: null,
      visible: true,
      clearRecentActivity: false,
      cardFarmingEnabled: false,
      enabled: true
    });
    const updated = store.updateRuntime(account.id, { status: "online", lastError: null });
    assert.equal(updated.status, "online");
    assert.equal(updated.revision, account.revision);
    store.close();
  });

  it("replaces and reads the cached game library", () => {
    const store = createStore();
    const account = store.create({
      accountName: "library-test",
      steamId: "76561198000000000",
      refreshTokenEncrypted: "encrypted",
      machineAuthTokenEncrypted: null,
      appIds: [730],
      customGame: null,
      visible: true,
      clearRecentActivity: false,
      cardFarmingEnabled: false,
      enabled: true
    });

    store.replaceOwnedGames(account.id, [
      { appId: 730, name: " Counter-Strike 2 ", playtimeForever: 600 },
      { appId: 440, name: "Team Fortress 2", playtimeForever: 120 },
      { appId: 0, name: "Invalid", playtimeForever: 1 }
    ]);
    assert.deepEqual(
      store.listOwnedGames(account.id).sort((left, right) => left.appId - right.appId),
      [
        { appId: 440, name: "Team Fortress 2", playtimeForever: 120 },
        { appId: 730, name: "Counter-Strike 2", playtimeForever: 600 }
      ]
    );

    store.replaceOwnedGames(account.id, [
      { appId: 570, name: "Dota 2", playtimeForever: 30 }
    ]);
    assert.deepEqual(store.listOwnedGames(account.id), [
      { appId: 570, name: "Dota 2", playtimeForever: 30 }
    ]);
    store.close();
  });

  it("allows only one active runner lease", () => {
    const store = createStore();
    assert.equal(store.claimRunner("runner-one"), true);
    assert.equal(store.claimRunner("runner-two"), false);
    assert.doesNotThrow(() => store.heartbeatRunner("runner-one"));
    store.releaseRunner("runner-one");
    assert.equal(store.claimRunner("runner-two"), true);
    store.close();
  });

  it("migrates existing accounts with recent-activity clearing disabled", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "linger-test-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "linger.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        account_name TEXT NOT NULL UNIQUE,
        steam_id TEXT,
        refresh_token_encrypted TEXT NOT NULL,
        machine_auth_token_encrypted TEXT,
        app_ids_json TEXT NOT NULL,
        custom_game TEXT,
        visible INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        restart_nonce INTEGER NOT NULL,
        status TEXT NOT NULL,
        last_error TEXT,
        last_connected_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE runner_lease (
        singleton INTEGER PRIMARY KEY,
        owner_id TEXT NOT NULL,
        heartbeat_at INTEGER NOT NULL
      );
      INSERT INTO accounts VALUES (
        'id', 'existing', NULL, 'encrypted', NULL, '[730]', NULL, 1, 1, 1, 0,
        'idle', NULL, NULL, 'now', 'now'
      );
      PRAGMA user_version = 2;
    `);
    database.close();

    const store = new AccountStore(databasePath);
    assert.equal(store.get("id")?.clearRecentActivity, false);
    assert.equal(store.get("id")?.cardFarmingEnabled, false);
    assert.deepEqual(store.get("id")?.cardFarmingQueue, []);
    store.close();
  });

  it("persists card queues and disables farming after completion", () => {
    const store = createStore();
    const account = store.create({
      accountName: "cards-only",
      steamId: null,
      refreshTokenEncrypted: "encrypted",
      machineAuthTokenEncrypted: null,
      appIds: [],
      customGame: null,
      visible: false,
      clearRecentActivity: false,
      cardFarmingEnabled: true,
      enabled: true
    });

    const queued = store.replaceCardFarmingQueue(account.id, [
      { appId: 440, remainingDrops: 2 }
    ]);
    assert.deepEqual(queued.cardFarmingQueue, [{ appId: 440, remainingDrops: 2 }]);

    const finished = store.finishCardFarming(account.id);
    assert.equal(finished.cardFarmingEnabled, false);
    assert.deepEqual(finished.cardFarmingQueue, []);
    assert.equal(finished.enabled, false);
    assert.equal(finished.status, "disabled");
    store.close();
  });
});
