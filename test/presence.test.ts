import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGamesPlayed } from "../src/steam/presence.js";

describe("Steam presence", () => {
  it("places the custom game alongside configured AppIDs", () => {
    assert.deepEqual(
      buildGamesPlayed({ appIds: [730, 440], customGame: "Linger", visible: true }),
      ["Linger", 730, 440]
    );
  });
});
