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

  it("places real activity after helper entries so it wins the visible playing slot", () => {
    const plan = buildPresencePlan({
      appIds: [730],
      customGame: null,
      visible: false,
      clearRecentActivity: true
    });
    assert.deepEqual(plan.baseGames, [730]);
    assert.deepEqual(plan.games, [...RECENT_ACTIVITY_APP_IDS, 730]);
  });

  it("finishes the clearing transition even when a helper license request fails", async () => {
    const played: Array<Array<number | string>> = [];
    const personas: SteamUser.EPersonaState[] = [];
    let licenseErrors = 0;
    const client = {
      setPersona(persona: SteamUser.EPersonaState) {
        personas.push(persona);
      },
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
      visible: true,
      clearRecentActivity: true
    });

    assert.deepEqual(played, [
      [...RECENT_ACTIVITY_APP_IDS],
      [...RECENT_ACTIVITY_APP_IDS, 730]
    ]);
    assert.deepEqual(personas, [SteamUser.EPersonaState.Invisible, SteamUser.EPersonaState.Online]);
    assert.equal(licenseErrors, 1);
  });
});
