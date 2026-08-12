import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_GAMES_PLAYED, parseAppIds, validatePresence } from "../src/domain/account.js";

describe("account presence", () => {
  it("parses, validates, and deduplicates AppIDs", () => {
    assert.deepEqual(parseAppIds("730, 440  730\n570"), [730, 440, 570]);
    assert.throws(() => parseAppIds("730, nope"), /Invalid AppID/u);
  });

  it("requires something to idle", () => {
    assert.throws(
      () => validatePresence({ appIds: [], customGame: null, visible: true }),
      /at least one AppID or a custom game name/iu
    );
  });

  it("enforces Steam's simultaneous presence limit", () => {
    const appIds = Array.from({ length: MAX_GAMES_PLAYED }, (_, index) => index + 1);
    assert.doesNotThrow(() => validatePresence({ appIds, customGame: null, visible: true }));
    assert.throws(
      () => validatePresence({ appIds, customGame: "Linger", visible: true }),
      /at most 32/iu
    );
  });
});
