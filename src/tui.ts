import {
  confirm,
  input,
  password,
  select
} from "@inquirer/prompts";
import qrcode from "qrcode-terminal";
import { CredentialVault } from "./crypto.js";
import { AccountStore } from "./database.js";
import type { Account, AccountConfiguration } from "./domain/account.js";
import {
  MAX_CUSTOM_GAME_LENGTH,
  MAX_GAMES_PLAYED,
  RECENT_ACTIVITY_RESERVED_SLOTS,
  parseAppIds,
  validatePresence
} from "./domain/account.js";
import {
  authenticate,
  type AuthenticationInteraction,
  type AuthenticationResult,
  type GuardChoice,
  type LoginMethod
} from "./steam/authentication.js";

const STATUS_LABELS: Record<Account["status"], string> = {
  disabled: "disabled",
  idle: "waiting for runner",
  connecting: "connecting",
  online: "online",
  backoff: "waiting to retry",
  needs_auth: "needs login",
  error: "error"
};

function printHeader(): void {
  process.stdout.write("\nLinger · Steam hour booster\n\n");
}

function pauseMessage(message: string): void {
  process.stdout.write(`\n${message}\n`);
}

function guardLabel(choice: GuardChoice): string {
  switch (choice.type) {
    case "email_code":
      return `Email code${choice.detail ? ` (${choice.detail})` : ""}`;
    case "device_code":
      return "Steam Guard authenticator code";
    case "device_confirmation":
      return "Approve in the Steam Mobile app";
    case "email_confirmation":
      return "Approve using Steam's email";
  }
}

function createAuthenticationInteraction(): AuthenticationInteraction {
  return {
    showQrCode(url) {
      process.stdout.write("\nScan this code in the Steam Mobile app:\n\n");
      qrcode.generate(url, { small: true }, (code) => process.stdout.write(`${code}\n`));
    },
    chooseGuard(choices) {
      return select({
        message: "Complete Steam Guard using",
        choices: choices.map((choice) => ({ name: guardLabel(choice), value: choice }))
      });
    },
    requestGuardCode(choice, signal) {
      return input(
        { message: choice.type === "email_code" ? "Email code" : "Authenticator code" },
        { signal }
      );
    },
    notify(message) {
      pauseMessage(message);
    }
  };
}

async function promptLoginMethod(
  existing?: Pick<Account, "accountName" | "machineAuthTokenEncrypted">
): Promise<{ method: LoginMethod; usedStoredMachineToken: boolean }> {
  const type = await select({
    message: "Sign in with",
    choices: [
      { name: "Steam Mobile QR code", value: "qr" as const },
      { name: "Username and password", value: "credentials" as const }
    ]
  });
  if (type === "qr") {
    return { method: { type: "qr" }, usedStoredMachineToken: false };
  }

  const accountName = existing?.accountName ?? (await input({ message: "Steam account name" })).trim();
  if (!accountName) {
    throw new Error("Steam account name is required");
  }
  const accountPassword = await password({ message: "Steam password", mask: "•" });
  if (!accountPassword) {
    throw new Error("Steam password is required");
  }

  return {
    method: { type: "credentials", accountName, password: accountPassword },
    usedStoredMachineToken: Boolean(existing?.machineAuthTokenEncrypted)
  };
}

async function promptConfiguration(current?: AccountConfiguration): Promise<AccountConfiguration> {
  const customGameValue = await input({
    message: "Custom game name (optional)",
    default: current?.customGame ?? "",
    validate(value) {
      return value.trim().length <= MAX_CUSTOM_GAME_LENGTH
        ? true
        : `Use ${MAX_CUSTOM_GAME_LENGTH} characters or fewer`;
    }
  });
  const customGame = customGameValue.trim() || null;
  const clearRecentActivity = await confirm({
    message: "Clear recent activity while boosting?",
    default: current?.clearRecentActivity ?? false
  });
  const appIdsValue = await input({
    message: "Game AppIDs (comma or space separated)",
    default: current?.appIds.join(", ") ?? "",
    validate(value) {
      try {
        validatePresence({
          appIds: parseAppIds(value),
          customGame,
          visible: true,
          clearRecentActivity
        });
        return true;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
  });
  const visible = await confirm({
    message: "Show this account as online and playing?",
    default: current?.visible ?? true
  });

  return { appIds: parseAppIds(appIdsValue), customGame, visible, clearRecentActivity };
}

function currentConfiguration(account: Account): AccountConfiguration {
  return {
    appIds: account.appIds,
    customGame: account.customGame,
    visible: account.visible,
    clearRecentActivity: account.clearRecentActivity
  };
}

function updateConfiguration(
  store: AccountStore,
  account: Account,
  patch: Partial<AccountConfiguration>
): Account {
  return store.updateConfiguration(account.id, { ...currentConfiguration(account), ...patch });
}

async function promptCustomGame(account: Account): Promise<string | null> {
  const value = await input({
    message: `Custom game title (current: ${account.customGame ?? "none"}; blank keeps, "-" clears)`,
    validate(candidate) {
      const trimmed = candidate.trim();
      if (trimmed.length > MAX_CUSTOM_GAME_LENGTH) {
        return `Use ${MAX_CUSTOM_GAME_LENGTH} characters or fewer`;
      }
      try {
        validatePresence({
          ...currentConfiguration(account),
          customGame: !trimmed ? account.customGame : trimmed === "-" ? null : trimmed
        });
        return true;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
  });
  const trimmed = value.trim();
  if (!trimmed) {
    return account.customGame;
  }
  return trimmed === "-" ? null : trimmed;
}

async function promptGameAppIds(account: Account): Promise<number[]> {
  const current = account.appIds.length > 0 ? account.appIds.join(", ") : "none";
  const value = await input({
    message: `Game AppIDs (current: ${current}; blank keeps, "-" clears)`,
    validate(candidate) {
      try {
        const trimmed = candidate.trim();
        const appIds = !trimmed ? account.appIds : trimmed === "-" ? [] : parseAppIds(trimmed);
        validatePresence({ ...currentConfiguration(account), appIds });
        return true;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
  });
  const trimmed = value.trim();
  return !trimmed ? account.appIds : trimmed === "-" ? [] : parseAppIds(trimmed);
}

async function promptVisibility(account: Account): Promise<boolean> {
  const choices = [
    { name: "Visible · show online and playing", value: true },
    { name: "Invisible · still boost hours", value: false }
  ];
  return select({
    message: `Visibility (current: ${account.visible ? "visible" : "invisible"})`,
    choices: account.visible ? choices : choices.reverse()
  });
}

async function promptRecentActivity(account: Account): Promise<boolean> {
  const choices = [
    { name: "Enabled · hide recently played games", value: true },
    { name: "Disabled", value: false }
  ];
  return select({
    message: `Clear recent activity (current: ${account.clearRecentActivity ? "enabled" : "disabled"})`,
    choices: account.clearRecentActivity ? choices : choices.reverse()
  });
}

function accountSummary(account: Account): string {
  const games = account.appIds.length > 0 ? account.appIds.join(", ") : "none";
  return [
    `Account: ${account.accountName}`,
    `SteamID: ${account.steamId ?? "unknown"}`,
    `State: ${STATUS_LABELS[account.status]}`,
    `Enabled: ${account.enabled ? "yes" : "no"}`,
    `Visibility: ${account.visible ? "visible" : "invisible"}`,
    `Clear recent activity: ${account.clearRecentActivity ? "enabled" : "disabled"}`,
    `AppIDs: ${games}`,
    `Custom game: ${account.customGame ?? "none"}`,
    account.lastConnectedAt ? `Last connected: ${account.lastConnectedAt}` : null,
    account.lastError ? `Last error: ${account.lastError}` : null
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

async function performLogin(
  vault: CredentialVault,
  existing?: Account
): Promise<AuthenticationResult> {
  const selected = await promptLoginMethod(existing);
  let method = selected.method;
  if (
    method.type === "credentials" &&
    selected.usedStoredMachineToken &&
    existing?.machineAuthTokenEncrypted
  ) {
    method = {
      ...method,
      machineAuthToken: vault.decrypt(existing.machineAuthTokenEncrypted)
    };
  }
  return authenticate(method, createAuthenticationInteraction());
}

async function addAccount(store: AccountStore, vault: CredentialVault): Promise<void> {
  const login = await performLogin(vault);
  if (store.getByName(login.accountName)) {
    throw new Error(`Account already exists: ${login.accountName}`);
  }
  const configuration = await promptConfiguration();
  const account = store.create({
    accountName: login.accountName,
    steamId: login.steamId,
    refreshTokenEncrypted: vault.encrypt(login.refreshToken),
    machineAuthTokenEncrypted: login.machineAuthToken ? vault.encrypt(login.machineAuthToken) : null,
    ...configuration,
    enabled: true
  });
  pauseMessage(`Added ${account.accountName}. The runner will connect it automatically.`);
}

async function reauthenticateAccount(
  store: AccountStore,
  vault: CredentialVault,
  account: Account
): Promise<Account> {
  const login = await performLogin(vault, account);
  if (account.steamId && login.steamId !== account.steamId) {
    throw new Error("That login belongs to a different Steam account");
  }
  const updated = store.replaceCredentials(account.id, {
    accountName: login.accountName,
    steamId: login.steamId,
    refreshTokenEncrypted: vault.encrypt(login.refreshToken),
    machineAuthTokenEncrypted: login.machineAuthToken ? vault.encrypt(login.machineAuthToken) : null
  });
  pauseMessage(`Refreshed the login for ${updated.accountName}.`);
  return updated;
}

async function manageAccount(store: AccountStore, vault: CredentialVault, initial: Account): Promise<void> {
  let account = initial;
  while (true) {
    process.stdout.write(`\n${accountSummary(account)}\n\n`);
    const action = await select({
      message: `Manage ${account.accountName}`,
      loop: false,
      choices: [
        {
          name: `Custom game title · ${account.customGame ?? "none"}`,
          value: "customGame"
        },
        {
          name: `Game AppIDs · ${account.appIds.length > 0 ? account.appIds.join(", ") : "none"}`,
          value: "appIds"
        },
        {
          name: `Visibility · ${account.visible ? "visible" : "invisible"}`,
          value: "visibility"
        },
        {
          name: `Clear recent activity · ${account.clearRecentActivity ? "enabled" : "disabled"}`,
          value: "recentActivity"
        },
        {
          name: account.enabled ? "Disable account" : "Enable account",
          value: "toggle"
        },
        { name: "Restart Steam session", value: "restart", disabled: !account.enabled },
        { name: "Re-authenticate", value: "reauthenticate" },
        { name: "Delete account", value: "delete" },
        { name: "Back", value: "back" }
      ]
    });

    switch (action) {
      case "customGame": {
        const customGame = await promptCustomGame(account);
        account = updateConfiguration(store, account, { customGame });
        pauseMessage("Custom game title saved.");
        break;
      }
      case "appIds":
        account = updateConfiguration(store, account, { appIds: await promptGameAppIds(account) });
        pauseMessage("Game AppIDs saved.");
        break;
      case "visibility":
        account = updateConfiguration(store, account, { visible: await promptVisibility(account) });
        pauseMessage("Visibility saved.");
        break;
      case "recentActivity": {
        const clearRecentActivity = await promptRecentActivity(account);
        try {
          account = updateConfiguration(store, account, { clearRecentActivity });
          pauseMessage("Recent-activity setting saved.");
        } catch (error) {
          if (clearRecentActivity) {
            throw new Error(
              `Could not enable recent-activity clearing: ${error instanceof Error ? error.message : String(error)}`
            );
          }
          throw error;
        }
        break;
      }
      case "toggle":
        account = store.setEnabled(account.id, !account.enabled);
        pauseMessage(`${account.accountName} is now ${account.enabled ? "enabled" : "disabled"}.`);
        break;
      case "restart":
        account = store.requestRestart(account.id);
        pauseMessage("Restart requested. The runner will apply it shortly.");
        break;
      case "reauthenticate":
        account = await reauthenticateAccount(store, vault, account);
        break;
      case "delete":
        if (
          await confirm({
            message: `Permanently delete ${account.accountName} from Linger?`,
            default: false
          })
        ) {
          store.delete(account.id);
          pauseMessage(`Deleted ${account.accountName}.`);
          return;
        }
        break;
      case "back":
        return;
    }
  }
}

async function chooseAccount(store: AccountStore): Promise<Account | null> {
  const accounts = store.list();
  if (accounts.length === 0) {
    pauseMessage("No Steam accounts have been added yet.");
    return null;
  }
  return select({
    message: "Choose an account",
    loop: false,
    choices: [
      ...accounts.map((account) => ({
        name: `${account.accountName} · ${STATUS_LABELS[account.status]} · ${account.appIds.length + (account.customGame ? 1 : 0)}/${account.clearRecentActivity ? MAX_GAMES_PLAYED - RECENT_ACTIVITY_RESERVED_SLOTS : MAX_GAMES_PLAYED} games`,
        value: account
      })),
      { name: "Back", value: null }
    ]
  });
}

export async function runManagementTui(store: AccountStore, vault: CredentialVault): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("The account manager requires an interactive terminal (TTY)");
  }

  while (true) {
    printHeader();
    const action = await select({
      message: "What would you like to do?",
      choices: [
        { name: "Add Steam account", value: "add" },
        { name: "Manage accounts", value: "accounts" },
        { name: "Exit", value: "exit" }
      ]
    });

    try {
      if (action === "add") {
        await addAccount(store, vault);
      } else if (action === "accounts") {
        const account = await chooseAccount(store);
        if (account) {
          await manageAccount(store, vault, account);
        }
      } else {
        return;
      }
    } catch (error) {
      pauseMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
