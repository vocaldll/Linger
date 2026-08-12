import SteamUser from "steam-user";
import type { AccountConfiguration } from "../domain/account.js";
import { validatePresence } from "../domain/account.js";

export const RECENT_ACTIVITY_APP_IDS = [635240, 635241, 635242, 635243] as const;

export type PresencePlan = {
  baseGames: Array<number | string>;
  games: Array<number | string>;
  clearRecentActivity: boolean;
};

export function buildGamesPlayed(configuration: AccountConfiguration): Array<number | string> {
  validatePresence(configuration);
  return [
    ...(configuration.customGame?.trim() ? [configuration.customGame.trim()] : []),
    ...configuration.appIds
  ];
}

export function buildPresencePlan(configuration: AccountConfiguration): PresencePlan {
  const baseGames = buildGamesPlayed(configuration);
  return {
    baseGames,
    games: configuration.clearRecentActivity
      ? [...RECENT_ACTIVITY_APP_IDS, ...baseGames]
      : baseGames,
    clearRecentActivity: configuration.clearRecentActivity
  };
}

export class PresenceController {
  #revision = 0;
  #disposed = false;
  #licenseRequest: Promise<unknown> | null = null;

  constructor(
    private readonly client: SteamUser,
    private readonly transitionDelayMs = 3_000,
    private readonly onLicenseError: (error: unknown) => void = () => {}
  ) {}

  async apply(configuration: AccountConfiguration): Promise<void> {
    if (this.#disposed) {
      return;
    }
    const revision = ++this.#revision;
    const plan = buildPresencePlan(configuration);
    if (!plan.clearRecentActivity) {
      this.client.setPersona(
        configuration.visible ? SteamUser.EPersonaState.Online : SteamUser.EPersonaState.Invisible
      );
      this.client.gamesPlayed(plan.games);
      return;
    }

    // Keep helper apps hidden during the transition. Starting the configured games last makes
    // Steam prefer the user's real activity for the visible "currently playing" slot.
    this.client.setPersona(SteamUser.EPersonaState.Invisible);
    this.client.gamesPlayed([...RECENT_ACTIVITY_APP_IDS]);
    await Promise.all([
      this.#requestRecentActivityLicenses().catch((error) => this.onLicenseError(error)),
      this.#delay()
    ]);
    if (!this.#disposed && revision === this.#revision) {
      this.client.gamesPlayed(plan.games);
      this.client.setPersona(
        configuration.visible ? SteamUser.EPersonaState.Online : SteamUser.EPersonaState.Invisible
      );
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#revision += 1;
  }

  #requestRecentActivityLicenses(): Promise<unknown> {
    if (!this.#licenseRequest) {
      this.#licenseRequest = this.client.requestFreeLicense([...RECENT_ACTIVITY_APP_IDS]).catch((error) => {
        this.#licenseRequest = null;
        throw error;
      });
    }
    return this.#licenseRequest;
  }

  #delay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.transitionDelayMs));
  }
}
