import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
      enabled: true
    });

    assert.equal(store.getByName("VOCAL")?.id, account.id);
    const updated = store.updateConfiguration(account.id, {
      appIds: [440, 570],
      customGame: "Linger",
      visible: false
    });
    assert.deepEqual(updated.appIds, [440, 570]);
    assert.equal(updated.customGame, "Linger");
    assert.equal(updated.visible, false);
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
      enabled: true
    });
    const updated = store.updateRuntime(account.id, { status: "online", lastError: null });
    assert.equal(updated.status, "online");
    assert.equal(updated.revision, account.revision);
    store.close();
  });
});
