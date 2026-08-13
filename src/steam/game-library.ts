import SteamUser from "steam-user";
import type { OwnedGame } from "../domain/game-library.js";

const LIBRARY_LOGIN_TIMEOUT_MS = 30_000;

type OwnedAppLike = {
  appid: number;
  name: string;
  playtime_forever: number;
};

export function normalizeOwnedGames(apps: readonly OwnedAppLike[]): OwnedGame[] {
  const games = new Map<number, OwnedGame>();
  for (const app of apps) {
    const name = app.name?.trim();
    const playtime = Number.isSafeInteger(app.playtime_forever)
      ? Math.max(0, app.playtime_forever)
      : 0;
    if (Number.isSafeInteger(app.appid) && app.appid > 0 && name) {
      games.set(app.appid, { appId: app.appid, name, playtimeForever: playtime });
    }
  }
  return [...games.values()];
}

export async function getOwnedGames(client: SteamUser, steamId: string): Promise<OwnedGame[]> {
  const response = await client.getUserOwnedApps(steamId, { includePlayedFreeGames: true });
  return normalizeOwnedGames(response.apps);
}

export function fetchOwnedGamesForLogin(
  refreshToken: string,
  steamId: string,
  machineAuthToken?: string | null
): Promise<OwnedGame[]> {
  const client = new SteamUser({
    autoRelogin: false,
    renewRefreshTokens: false,
    dataDirectory: null,
    enablePicsCache: false
  });

  return new Promise<OwnedGame[]>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error("Steam library loading timed out")),
      LIBRARY_LOGIN_TIMEOUT_MS
    );

    const finish = (error: Error | null, games?: OwnedGame[]): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      client.removeAllListeners();
      try {
        client.logOff();
      } catch {}
      if (error) {
        reject(error);
      } else {
        resolve(games ?? []);
      }
    };

    client.once("loggedOn", () => {
      void getOwnedGames(client, steamId).then(
        (games) => finish(null, games),
        (error: unknown) =>
          finish(error instanceof Error ? error : new Error(String(error)))
      );
    });
    client.once("error", (error) => finish(error));
    client.once("disconnected", (_result, message) =>
      finish(new Error(message || "Steam disconnected while loading the game library"))
    );

    try {
      client.logOn({
        refreshToken,
        ...(machineAuthToken ? { machineAuthToken } : {}),
        steamID: steamId,
        machineName: "Linger library"
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
