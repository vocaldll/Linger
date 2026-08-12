import SteamUser from "steam-user";
import type { AccountConfiguration } from "../domain/account.js";
import { validatePresence } from "../domain/account.js";

export function buildGamesPlayed(configuration: AccountConfiguration): Array<number | string> {
  validatePresence(configuration);
  return [
    ...(configuration.customGame?.trim() ? [configuration.customGame.trim()] : []),
    ...configuration.appIds
  ];
}

export function applyPresence(client: SteamUser, configuration: AccountConfiguration): void {
  client.setPersona(
    configuration.visible ? SteamUser.EPersonaState.Online : SteamUser.EPersonaState.Invisible
  );
  client.gamesPlayed(buildGamesPlayed(configuration));
}
