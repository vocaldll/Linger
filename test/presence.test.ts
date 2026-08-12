import assert from "node:assert/strict";
import { describe, it } from "node:test";
import SteamUser from "steam-user";
import {
  buildGamesPlayed,
  buildPresencePlan,
  PresenceController,
  RECENT_ACTIVITY_APP_IDS
} from "../src/steam/presence.js";

describe("Steam presence", () => {
  it("places the custom game alongside configured AppIDs", () => {
    assert.deepEqual(
      buildGamesPlayed({
        appIds: [730, 440],
        customGame: "Linger",
        visible: true,
        clearRecentActivity: false
      }),
      ["Linger", 730, 440]
    );
  });

  it("appends the non-game activity entries only when configured", () => {
    const plan = buildPresencePlan({
      appIds: [730],
      customGame: null,
      visible: false,
      clearRecentActivity: true
    });
    assert.deepEqual(plan.baseGames, [730]);
    assert.deepEqual(plan.games, [730, ...RECENT_ACTIVITY_APP_IDS]);
  });

  it("finishes the clearing transition even when a helper license request fails", async () => {
    const played: Array<Array<number | string>> = [];
    let licenseErrors = 0;
    const client = {
      setPersona() {},
      gamesPlayed(games: Array<number | string>) {
        played.push([...games]);
      },
      requestFreeLicense() {
        return Promise.reject(new Error("license unavailable"));
      }
    } as unknown as SteamUser;
    const presence = new PresenceController(client, 0, () => {
      licenseErrors += 1;
    });

    await presence.apply({
      appIds: [730],
      customGame: null,
      visible: false,
      clearRecentActivity: true
    });

    assert.deepEqual(played, [[730], [730, ...RECENT_ACTIVITY_APP_IDS]]);
    assert.equal(licenseErrors, 1);
  });
});
