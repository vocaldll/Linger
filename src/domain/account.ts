export const MAX_GAMES_PLAYED = 32;
export const MAX_CUSTOM_GAME_LENGTH = 128;
export const RECENT_ACTIVITY_RESERVED_SLOTS = 3;

export type AccountStatus =
  | "disabled"
  | "idle"
  | "connecting"
  | "online"
  | "backoff"
  | "needs_auth"
  | "error";

export type Account = {
  id: string;
  accountName: string;
  steamId: string | null;
  refreshTokenEncrypted: string;
  machineAuthTokenEncrypted: string | null;
  appIds: number[];
  customGame: string | null;
  visible: boolean;
  clearRecentActivity: boolean;
  enabled: boolean;
  revision: number;
  restartNonce: number;
  status: AccountStatus;
  lastError: string | null;
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewAccount = Omit<
  Account,
  "id" | "revision" | "restartNonce" | "status" | "lastError" | "lastConnectedAt" | "createdAt" | "updatedAt"
>;

export type AccountConfiguration = Pick<
  Account,
  "appIds" | "customGame" | "visible" | "clearRecentActivity"
>;

export type RuntimePatch = Partial<
  Pick<Account, "steamId" | "status" | "lastError" | "lastConnectedAt" | "refreshTokenEncrypted" | "machineAuthTokenEncrypted">
>;

export function parseAppIds(input: string): number[] {
  const values = input
    .split(/[\s,]+/u)
    .map((value) => value.trim())
    .filter(Boolean);

  const appIds: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    if (!/^\d+$/u.test(value)) {
      throw new Error(`Invalid AppID: ${value}`);
    }
    const appId = Number(value);
    if (!Number.isSafeInteger(appId) || appId <= 0 || appId > 0xffff_ffff) {
      throw new Error(`Invalid AppID: ${value}`);
    }
    if (!seen.has(appId)) {
      seen.add(appId);
      appIds.push(appId);
    }
  }

  return appIds;
}

export function validatePresence(configuration: AccountConfiguration): void {
  const customGame = configuration.customGame?.trim() || null;
  if (customGame && customGame.length > MAX_CUSTOM_GAME_LENGTH) {
    throw new Error(`Custom game name must be ${MAX_CUSTOM_GAME_LENGTH} characters or fewer`);
  }
  const slots = configuration.appIds.length + (customGame ? 1 : 0);
  const availableSlots = configuration.clearRecentActivity
    ? MAX_GAMES_PLAYED - RECENT_ACTIVITY_RESERVED_SLOTS
    : MAX_GAMES_PLAYED;
  if (slots === 0) {
    throw new Error("Configure at least one AppID or a custom game name");
  }
  if (slots > availableSlots) {
    throw new Error(
      configuration.clearRecentActivity
        ? `Recent-activity clearing leaves room for at most ${availableSlots} games`
        : `Steam supports at most ${MAX_GAMES_PLAYED} simultaneous games`
    );
  }
  for (const appId of configuration.appIds) {
    if (!Number.isSafeInteger(appId) || appId <= 0 || appId > 0xffff_ffff) {
      throw new Error(`Invalid AppID: ${appId}`);
    }
  }
}
