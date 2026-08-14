import { confirm, input, password, search, select } from "@inquirer/prompts";
import qrcode from "qrcode-terminal";
import type { CredentialVault } from "./crypto.js";
import type { AccountStore } from "./database.js";
import type {
	Account,
	AccountConfiguration,
	AccountSetup,
} from "./domain/account.js";
import {
	MAX_CUSTOM_GAME_LENGTH,
	MAX_GAMES_PLAYED,
	parseAppIds,
	RECENT_ACTIVITY_RESERVED_SLOTS,
	validateAccountSetup,
} from "./domain/account.js";
import {
	GAME_SORT_LABELS,
	type GameSort,
	type OwnedGame,
} from "./domain/game-library.js";
import {
	type AuthenticationInteraction,
	type AuthenticationResult,
	authenticate,
	type GuardChoice,
	type LoginMethod,
} from "./steam/authentication.js";
import { fetchOwnedGamesForLogin } from "./steam/game-library.js";
import { gamePicker } from "./tui/game-picker.js";
import { LINGER_THEME, printLingerHeader, ui } from "./tui/theme.js";

const STATUS_LABELS: Record<Account["status"], string> = {
	disabled: "disabled",
	idle: "waiting for runner",
	connecting: "connecting",
	online: "online",
	backoff: "waiting to retry",
	needs_auth: "needs login",
	error: "error",
};

type SearchableAccount = Pick<Account, "accountName" | "steamId" | "status">;

export function filterAccountsForSearch<AccountType extends SearchableAccount>(
	accounts: readonly AccountType[],
	term: string | undefined,
): AccountType[] {
	const words =
		term?.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean) ?? [];
	if (words.length === 0) {
		return [...accounts];
	}
	return accounts.filter((account) => {
		const searchable = [
			account.accountName,
			account.steamId ?? "",
			account.status,
			STATUS_LABELS[account.status],
		]
			.join(" ")
			.toLocaleLowerCase();
		return words.every((word) => searchable.includes(word));
	});
}

function printHeader(): void {
	printLingerHeader();
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
			qrcode.generate(url, { small: true }, (code) =>
				process.stdout.write(`${code}\n`),
			);
		},
		chooseGuard(choices) {
			return select({
				message: "Complete Steam Guard using",
				theme: LINGER_THEME,
				choices: choices.map((choice) => ({
					name: guardLabel(choice),
					value: choice,
				})),
			});
		},
		requestGuardCode(choice, signal) {
			return input(
				{
					message:
						choice.type === "email_code" ? "Email code" : "Authenticator code",
					theme: LINGER_THEME,
				},
				{ signal },
			);
		},
		notify(message) {
			pauseMessage(message);
		},
	};
}

async function promptLoginMethod(
	existing?: Pick<Account, "accountName" | "machineAuthTokenEncrypted">,
): Promise<{ method: LoginMethod; usedStoredMachineToken: boolean }> {
	const type = await select({
		message: "Sign in with",
		theme: LINGER_THEME,
		choices: [
			{ name: "Steam Mobile QR code", value: "qr" as const },
			{ name: "Username and password", value: "credentials" as const },
		],
	});
	if (type === "qr") {
		return { method: { type: "qr" }, usedStoredMachineToken: false };
	}

	const accountName =
		existing?.accountName ??
		(
			await input({ message: "Steam account name", theme: LINGER_THEME })
		).trim();
	if (!accountName) {
		throw new Error("Steam account name is required");
	}
	const accountPassword = await password({
		message: "Steam password",
		mask: "•",
		theme: LINGER_THEME,
	});
	if (!accountPassword) {
		throw new Error("Steam password is required");
	}

	return {
		method: { type: "credentials", accountName, password: accountPassword },
		usedStoredMachineToken: Boolean(existing?.machineAuthTokenEncrypted),
	};
}

type GameSelectionContext = Pick<
	AccountSetup,
	"customGame" | "clearRecentActivity" | "cardFarmingEnabled"
>;

function maximumSelectableAppIds(context: GameSelectionContext): number {
	return (
		MAX_GAMES_PLAYED -
		(context.clearRecentActivity ? RECENT_ACTIVITY_RESERVED_SLOTS : 0) -
		(context.customGame ? 1 : 0)
	);
}

async function promptGamePicker(
	ownedGames: readonly OwnedGame[],
	initialAppIds: readonly number[],
	context: GameSelectionContext,
): Promise<number[] | null> {
	let selectedAppIds = [...initialAppIds];
	let sort: GameSort = "most_played";
	let query = "";
	let activeAppId: number | null = null;
	let notice: string | undefined;
	const maximumSelected = maximumSelectableAppIds(context);

	while (true) {
		const result = await gamePicker(
			{
				games: ownedGames,
				selectedAppIds,
				sort,
				maximumSelected,
				allowEmpty: Boolean(context.customGame) || context.cardFarmingEnabled,
				initialQuery: query,
				initialActiveAppId: activeAppId,
				...(notice ? { notice } : {}),
			},
			{ clearPromptOnDone: true },
		);
		selectedAppIds = result.selectedAppIds;
		query = result.query;
		activeAppId = result.activeAppId;
		notice = undefined;

		if (result.action === "save") {
			return selectedAppIds;
		}
		if (result.action === "cancel") {
			return null;
		}
		if (result.action === "sort") {
			sort = await select({
				message: "Sort games by",
				default: sort,
				theme: LINGER_THEME,
				choices: (
					Object.entries(GAME_SORT_LABELS) as Array<[GameSort, string]>
				).map(([value, name]) => ({ name, value })),
			});
			continue;
		}

		const value = await input({
			message: "Enter AppIDs (comma or space separated)",
			theme: LINGER_THEME,
			validate(candidate) {
				if (!candidate.trim()) {
					return true;
				}
				try {
					const entered = parseAppIds(candidate);
					const combined = [...new Set([...selectedAppIds, ...entered])];
					validateAccountSetup({
						appIds: combined,
						customGame: context.customGame,
						visible: true,
						clearRecentActivity: context.clearRecentActivity,
						cardFarmingEnabled: context.cardFarmingEnabled,
					});
					return true;
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
			},
		});
		if (!value.trim()) {
			notice = "No AppIDs added.";
			continue;
		}
		const entered = parseAppIds(value);
		const previousCount = selectedAppIds.length;
		selectedAppIds = [...new Set([...selectedAppIds, ...entered])];
		const added = selectedAppIds.length - previousCount;
		notice =
			added === 0
				? "Those AppIDs were already selected."
				: `Added ${added} AppID${added === 1 ? "" : "s"}.`;
	}
}

async function promptConfiguration(
	ownedGames: readonly OwnedGame[],
	current?: AccountSetup,
): Promise<AccountSetup | null> {
	const cardFarmingEnabled = await confirm({
		message:
			"Farm all currently available Steam trading cards before hour boosting?",
		default: current?.cardFarmingEnabled ?? false,
		theme: LINGER_THEME,
	});
	const customGameValue = await input({
		message: "Custom game name (optional)",
		default: current?.customGame ?? "",
		theme: LINGER_THEME,
		validate(value) {
			return value.trim().length <= MAX_CUSTOM_GAME_LENGTH
				? true
				: `Use ${MAX_CUSTOM_GAME_LENGTH} characters or fewer`;
		},
	});
	const customGame = customGameValue.trim() || null;
	const clearRecentActivity = await confirm({
		message: "Clear recent activity while boosting?",
		default: current?.clearRecentActivity ?? false,
		theme: LINGER_THEME,
	});
	const appIds = await promptGamePicker(ownedGames, current?.appIds ?? [], {
		customGame,
		clearRecentActivity,
		cardFarmingEnabled,
	});
	if (appIds === null) {
		return null;
	}
	const visible = await confirm({
		message: "Show this account as online and playing?",
		default: current?.visible ?? true,
		theme: LINGER_THEME,
	});

	return {
		appIds,
		customGame,
		visible,
		clearRecentActivity,
		cardFarmingEnabled,
	};
}

function currentConfiguration(account: Account): AccountConfiguration {
	return {
		appIds: account.appIds,
		customGame: account.customGame,
		visible: account.visible,
		clearRecentActivity: account.clearRecentActivity,
	};
}

function updateConfiguration(
	store: AccountStore,
	account: Account,
	patch: Partial<AccountConfiguration>,
): Account {
	return store.updateConfiguration(account.id, {
		...currentConfiguration(account),
		...patch,
	});
}

async function promptCustomGame(account: Account): Promise<string | null> {
	const value = await input({
		message: `Custom game title (current: ${account.customGame ?? "none"}; blank keeps, "-" clears)`,
		theme: LINGER_THEME,
		validate(candidate) {
			const trimmed = candidate.trim();
			if (trimmed.length > MAX_CUSTOM_GAME_LENGTH) {
				return `Use ${MAX_CUSTOM_GAME_LENGTH} characters or fewer`;
			}
			try {
				validateAccountSetup({
					...currentConfiguration(account),
					cardFarmingEnabled: account.cardFarmingEnabled,
					customGame: !trimmed
						? account.customGame
						: trimmed === "-"
							? null
							: trimmed,
				});
				return true;
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		},
	});
	const trimmed = value.trim();
	if (!trimmed) {
		return account.customGame;
	}
	return trimmed === "-" ? null : trimmed;
}

async function promptGameAppIds(
	store: AccountStore,
	account: Account,
): Promise<number[] | null> {
	return promptGamePicker(
		store.listOwnedGames(account.id),
		account.appIds,
		account,
	);
}

async function promptVisibility(account: Account): Promise<boolean> {
	const choices = [
		{ name: "Visible · show online and playing", value: true },
		{ name: "Invisible · still boost hours", value: false },
	];
	return select({
		message: `Visibility (current: ${account.visible ? "visible" : "invisible"})`,
		theme: LINGER_THEME,
		choices: account.visible ? choices : choices.reverse(),
	});
}

async function promptRecentActivity(account: Account): Promise<boolean> {
	const choices = [
		{ name: "Enabled · hide recently played games", value: true },
		{ name: "Disabled", value: false },
	];
	return select({
		message: `Clear recent activity (current: ${account.clearRecentActivity ? "enabled" : "disabled"})`,
		theme: LINGER_THEME,
		choices: account.clearRecentActivity ? choices : choices.reverse(),
	});
}

function accountSummary(account: Account): string {
	const games = account.appIds.length > 0 ? account.appIds.join(", ") : "none";
	const status =
		account.status === "online"
			? ui.success(`● ${STATUS_LABELS[account.status]}`)
			: account.status === "error" || account.status === "needs_auth"
				? ui.danger(`● ${STATUS_LABELS[account.status]}`)
				: account.status === "disabled"
					? ui.muted(`● ${STATUS_LABELS[account.status]}`)
					: ui.accent(`● ${STATUS_LABELS[account.status]}`);
	const row = (label: string, value: string): string =>
		`  ${ui.muted(label.padEnd(23))}${value}`;
	return [
		`  ${ui.accentStrong(account.accountName)}  ${status}`,
		"",
		row("Steam ID", account.steamId ?? "unknown"),
		row("Enabled", account.enabled ? "yes" : "no"),
		row("Visibility", account.visible ? "visible" : "invisible"),
		row(
			"Clear recent activity",
			account.clearRecentActivity ? "enabled" : "disabled",
		),
		row(
			"Card farming",
			account.cardFarmingEnabled
				? account.cardFarmingQueue[0]
					? `AppID ${account.cardFarmingQueue[0].appId} · ${account.cardFarmingQueue[0].remainingDrops} drops · ${account.cardFarmingQueue.length} queued`
					: "enabled · scanning"
				: "disabled",
		),
		row("Boosted AppIDs", games),
		row("Custom game", account.customGame ?? "none"),
		account.lastConnectedAt
			? row("Last connected", account.lastConnectedAt)
			: null,
		account.lastError ? row("Last error", ui.danger(account.lastError)) : null,
	]
		.filter((line): line is string => line !== null)
		.join("\n");
}

async function performLogin(
	vault: CredentialVault,
	existing?: Account,
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
			machineAuthToken: vault.decrypt(existing.machineAuthTokenEncrypted),
		};
	}
	return authenticate(method, createAuthenticationInteraction());
}

async function addAccount(
	store: AccountStore,
	vault: CredentialVault,
): Promise<void> {
	const login = await performLogin(vault);
	if (store.getByName(login.accountName)) {
		throw new Error(`Account already exists: ${login.accountName}`);
	}
	pauseMessage("Loading your Steam game library...");
	let ownedGames: OwnedGame[] = [];
	try {
		ownedGames = await fetchOwnedGamesForLogin(
			login.refreshToken,
			login.steamId,
			login.machineAuthToken,
		);
	} catch (error) {
		pauseMessage(
			`Could not load the Steam library: ${error instanceof Error ? error.message : String(error)}\nUse m in the picker to enter AppIDs manually.`,
		);
	}
	const configuration = await promptConfiguration(ownedGames);
	if (!configuration) {
		pauseMessage("Account setup cancelled.");
		return;
	}
	const account = store.create({
		accountName: login.accountName,
		steamId: login.steamId,
		refreshTokenEncrypted: vault.encrypt(login.refreshToken),
		machineAuthTokenEncrypted: login.machineAuthToken
			? vault.encrypt(login.machineAuthToken)
			: null,
		...configuration,
		enabled: true,
	});
	store.replaceOwnedGames(account.id, ownedGames);
	pauseMessage(
		`Added ${account.accountName}. The runner will connect it automatically.`,
	);
}

async function reauthenticateAccount(
	store: AccountStore,
	vault: CredentialVault,
	account: Account,
): Promise<Account> {
	const login = await performLogin(vault, account);
	if (account.steamId && login.steamId !== account.steamId) {
		throw new Error("That login belongs to a different Steam account");
	}
	const updated = store.replaceCredentials(account.id, {
		accountName: login.accountName,
		steamId: login.steamId,
		refreshTokenEncrypted: vault.encrypt(login.refreshToken),
		machineAuthTokenEncrypted: login.machineAuthToken
			? vault.encrypt(login.machineAuthToken)
			: null,
	});
	pauseMessage(`Refreshed the login for ${updated.accountName}.`);
	return updated;
}

async function manageAccount(
	store: AccountStore,
	vault: CredentialVault,
	initial: Account,
): Promise<void> {
	let account = initial;
	while (true) {
		const latest = store.get(account.id);
		if (!latest) {
			return;
		}
		account = latest;
		process.stdout.write(`\n${accountSummary(account)}\n\n`);
		const action = await select({
			message: `Manage ${account.accountName}`,
			loop: false,
			theme: LINGER_THEME,
			choices: [
				{
					name: `Custom game title · ${account.customGame ?? "none"}`,
					value: "customGame",
				},
				{
					name: `Boosted games · ${account.appIds.length} selected`,
					value: "appIds",
				},
				{
					name: `Visibility · ${account.visible ? "visible" : "invisible"}`,
					value: "visibility",
				},
				{
					name: `Clear recent activity · ${account.clearRecentActivity ? "enabled" : "disabled"}`,
					value: "recentActivity",
				},
				{
					name: `Card farming · ${account.cardFarmingEnabled ? `${account.cardFarmingQueue.length} queued` : "disabled"}`,
					value: "cardFarming",
				},
				{
					name: account.enabled ? "Disable account" : "Enable account",
					value: "toggle",
				},
				{
					name: "Restart Steam session",
					value: "restart",
					disabled: !account.enabled,
				},
				{ name: "Re-authenticate", value: "reauthenticate" },
				{ name: "Delete account", value: "delete" },
				{ name: "Back", value: "back" },
			],
		});

		switch (action) {
			case "customGame": {
				const customGame = await promptCustomGame(account);
				account = updateConfiguration(store, account, { customGame });
				pauseMessage("Custom game title saved.");
				break;
			}
			case "appIds": {
				const appIds = await promptGameAppIds(store, account);
				if (appIds === null) {
					pauseMessage("No changes saved.");
					break;
				}
				account = updateConfiguration(store, account, { appIds });
				pauseMessage("Boosted games saved.");
				break;
			}
			case "visibility":
				account = updateConfiguration(store, account, {
					visible: await promptVisibility(account),
				});
				pauseMessage("Visibility saved.");
				break;
			case "recentActivity": {
				const clearRecentActivity = await promptRecentActivity(account);
				try {
					account = updateConfiguration(store, account, {
						clearRecentActivity,
					});
					pauseMessage("Recent-activity setting saved.");
				} catch (error) {
					if (clearRecentActivity) {
						throw new Error(
							`Could not enable recent-activity clearing: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
					throw error;
				}
				break;
			}
			case "cardFarming": {
				const change = await confirm({
					message: account.cardFarmingEnabled
						? "Stop card farming and return to normal hour boosting?"
						: "Farm every game with card drops currently available?",
					default: !account.cardFarmingEnabled,
					theme: LINGER_THEME,
				});
				if (!change) {
					pauseMessage("No changes saved.");
					break;
				}
				account = store.setCardFarmingEnabled(
					account.id,
					!account.cardFarmingEnabled,
				);
				pauseMessage(
					account.cardFarmingEnabled
						? "Card farming enabled. Linger will scan Steam and begin automatically."
						: account.enabled
							? "Card farming disabled. Normal hour boosting will resume."
							: "Card farming disabled. The account had no boosted games and was disabled.",
				);
				break;
			}
			case "toggle":
				account = store.setEnabled(account.id, !account.enabled);
				pauseMessage(
					`${account.accountName} is now ${account.enabled ? "enabled" : "disabled"}.`,
				);
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
						default: false,
						theme: LINGER_THEME,
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
	return search<Account | null>({
		message: "Choose an account",
		theme: LINGER_THEME,
		source(term) {
			return [
				...filterAccountsForSearch(accounts, term).map((account) => ({
					name: `${account.accountName} · ${STATUS_LABELS[account.status]} · ${account.appIds.length + (account.customGame ? 1 : 0)}/${account.clearRecentActivity ? MAX_GAMES_PLAYED - RECENT_ACTIVITY_RESERVED_SLOTS : MAX_GAMES_PLAYED} games`,
					value: account,
					...(account.steamId
						? { description: `SteamID: ${account.steamId}` }
						: {}),
				})),
				{ name: "Back", value: null },
			];
		},
	});
}

export async function runManagementTui(
	store: AccountStore,
	vault: CredentialVault,
): Promise<void> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error(
			"The account manager requires an interactive terminal (TTY)",
		);
	}

	while (true) {
		printHeader();
		const action = await select({
			message: "What would you like to do?",
			theme: LINGER_THEME,
			choices: [
				{ name: "Add Steam account", value: "add" },
				{ name: "Manage accounts", value: "accounts" },
				{ name: "Exit", value: "exit" },
			],
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
			pauseMessage(
				`Error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
