import {
  EAuthSessionGuardType,
  EAuthTokenPlatformType,
  LoginSession
} from "steam-session";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;
const MACHINE_NAME = "Linger";

export type LoginMethod =
  | { type: "credentials"; accountName: string; password: string; machineAuthToken?: string }
  | { type: "qr" };

export type GuardChoice = {
  type: "email_code" | "device_code" | "device_confirmation" | "email_confirmation";
  detail: string | null;
};

export type AuthenticationInteraction = {
  showQrCode(url: string): void;
  chooseGuard(choices: GuardChoice[]): Promise<GuardChoice>;
  requestGuardCode(choice: GuardChoice, signal: AbortSignal): Promise<string>;
  notify(message: string): void;
};

export type AuthenticationResult = {
  accountName: string;
  steamId: string;
  refreshToken: string;
  machineAuthToken: string | null;
};

function mapGuard(type: EAuthSessionGuardType, detail?: string): GuardChoice | null {
  switch (type) {
    case EAuthSessionGuardType.EmailCode:
      return { type: "email_code", detail: detail ?? null };
    case EAuthSessionGuardType.DeviceCode:
      return { type: "device_code", detail: detail ?? null };
    case EAuthSessionGuardType.DeviceConfirmation:
      return { type: "device_confirmation", detail: detail ?? null };
    case EAuthSessionGuardType.EmailConfirmation:
      return { type: "email_confirmation", detail: detail ?? null };
    default:
      return null;
  }
}

function isCodeChoice(choice: GuardChoice): boolean {
  return choice.type === "email_code" || choice.type === "device_code";
}

export async function authenticate(
  method: LoginMethod,
  interaction: AuthenticationInteraction,
  createSession: () => LoginSession = () =>
    new LoginSession(EAuthTokenPlatformType.SteamClient, {
      machineId: true,
      machineFriendlyName: MACHINE_NAME
    })
): Promise<AuthenticationResult> {
  const session = createSession();
  session.loginTimeout = LOGIN_TIMEOUT_MS;

  const promptController = new AbortController();
  let machineAuthToken = method.type === "credentials" ? (method.machineAuthToken ?? null) : null;
  let settled = false;

  const outcome = new Promise<AuthenticationResult>((resolve, reject) => {
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      promptController.abort();
      callback();
    };

    session.on("steamGuardMachineToken", () => {
      machineAuthToken = session.steamGuardMachineToken;
    });
    session.on("remoteInteraction", () => {
      if (method.type === "credentials") {
        interaction.notify("Steam sign-in request opened on mobile.");
      }
    });
    session.on("authenticated", () => {
      finish(() =>
        resolve({
          accountName: session.accountName,
          steamId: session.steamID.getSteamID64(),
          refreshToken: session.refreshToken,
          machineAuthToken
        })
      );
    });
    session.on("timeout", () => finish(() => reject(new Error("Steam Guard approval timed out"))));
    session.on("error", (error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      finish(() => reject(normalized));
    });
  });

  try {
    const response =
      method.type === "qr"
        ? await session.startWithQR()
        : await session.startWithCredentials({
            accountName: method.accountName,
            password: method.password,
            ...(method.machineAuthToken ? { steamGuardMachineToken: method.machineAuthToken } : {})
          });

    if (response.qrChallengeUrl) {
      interaction.showQrCode(response.qrChallengeUrl);
    }

    if (method.type === "qr") {
      return await outcome;
    }

    if (response.actionRequired) {
      const choices = (response.validActions ?? [])
        .map((action) => mapGuard(action.type, action.detail))
        .filter((choice): choice is GuardChoice => choice !== null);
      if (choices.length === 0) {
        throw new Error("Steam did not offer a supported Steam Guard method");
      }

      const selected =
        choices.length === 1
          ? ({ kind: "choice", choice: choices[0]! } as const)
          : await Promise.race([
              interaction.chooseGuard(choices).then((choice) => ({ kind: "choice", choice }) as const),
              outcome.then((result) => ({ kind: "authenticated", result }) as const)
            ]);
      if (selected.kind === "authenticated") {
        return selected.result;
      }
      const choice = selected.choice;
      if (isCodeChoice(choice)) {
        while (!settled) {
          const entered = await Promise.race([
            interaction
              .requestGuardCode(choice, promptController.signal)
              .then((code) => ({ kind: "code", code }) as const),
            outcome.then((result) => ({ kind: "authenticated", result }) as const)
          ]);
          if (entered.kind === "authenticated") {
            return entered.result;
          }
          const code = entered.code.trim();
          try {
            await session.submitSteamGuardCode(code);
            break;
          } catch (error) {
            interaction.notify(error instanceof Error ? error.message : "Steam Guard code was rejected");
          }
        }
      } else if (choice.type === "device_confirmation") {
        interaction.notify("Approve the sign-in request in the Steam Mobile app.");
      } else {
        interaction.notify("Approve the sign-in request using the email Steam sent you.");
      }
    }

    return await outcome;
  } catch (error) {
    promptController.abort();
    session.cancelLoginAttempt();
    throw error;
  }
}
