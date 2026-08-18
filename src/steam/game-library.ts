import { createRequire } from "node:module";
import SteamUser from "steam-user";
import type { OwnedGame } from "../domain/game-library.js";
import type { SteamMachineIdentity } from "./machine-identity.js";

const LIBRARY_LOGIN_TIMEOUT_MS = 30_000;
const PLAYTIME_REQUEST_TIMEOUT_MS = 10_000;

type OwnedAppLike = {
	appid: number;
	name: string;
	playtime_forever: number;
};

type PlayedAppLike = {
	appid: number;
	playtime_forever: number;
};

type UnifiedResponseHeader = {
	proto?: {
		eresult?: number;
	};
};

type SteamProtobuf = object;

type SteamProtobufs = {
	CPlayer_GetLastPlayedTimes_Request: SteamProtobuf;
	CPlayer_GetLastPlayedTimes_Response: SteamProtobuf;
};

type SteamUserWithRawMessages = SteamUser & {
	_send(
		header: {
			msg: SteamUser.EMsg;
			proto: { target_job_name: "Player.ClientGetLastPlayedTimes#1" };
		},
		body: Buffer,
		callback: (response: unknown, header: UnifiedResponseHeader) => void,
	): void;
};

type SteamUserConstructorWithProtobufs = typeof SteamUser & {
	_encodeProto(schema: SteamProtobuf, value: unknown): Buffer;
	_decodeProto(
		schema: SteamProtobuf,
		value: unknown,
	): { games?: PlayedAppLike[] };
};

type ExtendedOwnedAppsOptions = SteamUser.GetUserOwnedAppsOptions & {
	includeAppInfo?: boolean;
	skipUnvettedApps?: boolean;
};

function ownedAppsOptions(
	overrides: Partial<ExtendedOwnedAppsOptions> = {},
): ExtendedOwnedAppsOptions {
	return {
		includePlayedFreeGames: true,
		includeFreeSub: true,
		skipUnvettedApps: false,
		...overrides,
	};
}

function normalizePlaytimes(
	apps: readonly PlayedAppLike[],
): Map<number, number> {
	return new Map(
		apps
			.filter(
				(app) =>
					Number.isSafeInteger(app.appid) &&
					app.appid > 0 &&
					Number.isSafeInteger(app.playtime_forever),
			)
			.map((app) => [app.appid, Math.max(0, app.playtime_forever)]),
	);
}

function isPlayedAppsResponse(
	value: unknown,
): value is { games?: PlayedAppLike[] } {
	return typeof value === "object" && value !== null && "games" in value;
}

export function getTrackedGamePlaytimes(
	client: SteamUser,
): Promise<Map<number, number>> {
	const messageClient = client as Partial<SteamUserWithRawMessages>;
	if (typeof messageClient._send !== "function") {
		return Promise.reject(
			new Error("The Steam client does not support tracked playtime requests"),
		);
	}
	const send = messageClient._send.bind(messageClient);

	return new Promise((resolve, reject) => {
		let settled = false;
		const timeout = setTimeout(
			() => finish(new Error("Steam playtime loading timed out")),
			PLAYTIME_REQUEST_TIMEOUT_MS,
		);
		const finish = (
			error: Error | null,
			playtimes?: Map<number, number>,
		): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			if (error) {
				reject(error);
			} else {
				resolve(playtimes ?? new Map());
			}
		};

		try {
			const require = createRequire(import.meta.url);
			const protobufs =
				require("steam-user/protobufs/generated/_load.js") as SteamProtobufs;
			const steamUser = SteamUser as SteamUserConstructorWithProtobufs;
			const request = steamUser._encodeProto(
				protobufs.CPlayer_GetLastPlayedTimes_Request,
				{ min_last_played: 0 },
			);
			send(
				{
					msg: SteamUser.EMsg.ServiceMethodCallFromClient,
					proto: {
						target_job_name: "Player.ClientGetLastPlayedTimes#1",
					},
				},
				request,
				(response, header) => {
					const result = header.proto?.eresult;
					if (result !== SteamUser.EResult.OK) {
						const name =
							typeof result === "number"
								? (SteamUser.EResult[result] ?? `EResult ${result}`)
								: "an invalid response";
						finish(new Error(`Steam playtime loading failed with ${name}`));
						return;
					}
					const decoded = isPlayedAppsResponse(response)
						? response
						: steamUser._decodeProto(
								protobufs.CPlayer_GetLastPlayedTimes_Response,
								response,
							);
					finish(null, normalizePlaytimes(decoded.games ?? []));
				},
			);
		} catch (error) {
			finish(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

export function normalizeOwnedGames(
	apps: readonly OwnedAppLike[],
): OwnedGame[] {
	const games = new Map<number, OwnedGame>();
	for (const app of apps) {
		const name = app.name?.trim();
		const playtime = Number.isSafeInteger(app.playtime_forever)
			? Math.max(0, app.playtime_forever)
			: 0;
		if (Number.isSafeInteger(app.appid) && app.appid > 0 && name) {
			games.set(app.appid, {
				appId: app.appid,
				name,
				playtimeForever: playtime,
			});
		}
	}
	return [...games.values()];
}

export type LoadedGameLibrary = {
	games: OwnedGame[];
	trackedPlaytimes: Map<number, number> | null;
};

export async function loadGameLibrary(
	client: SteamUser,
	steamId: string,
	trackedAppIds: readonly number[] = [],
): Promise<LoadedGameLibrary> {
	const [response, trackedPlaytimes] = await Promise.all([
		client.getUserOwnedApps(steamId, ownedAppsOptions()),
		getTrackedGamePlaytimes(client).catch(() => null),
	]);
	const games = new Map(
		normalizeOwnedGames(response.apps).map((game) => [
			game.appId,
			{
				...game,
				playtimeForever:
					trackedPlaytimes?.get(game.appId) ?? game.playtimeForever,
			},
		]),
	);
	if (trackedPlaytimes) {
		for (const appId of trackedAppIds) {
			const playtimeForever = trackedPlaytimes.get(appId);
			if (
				!games.has(appId) &&
				Number.isSafeInteger(appId) &&
				appId > 0 &&
				playtimeForever !== undefined
			) {
				games.set(appId, {
					appId,
					name: `AppID ${appId}`,
					playtimeForever,
				});
			}
		}
	}
	return { games: [...games.values()], trackedPlaytimes };
}

export async function getOwnedGames(
	client: SteamUser,
	steamId: string,
	trackedAppIds: readonly number[] = [],
): Promise<OwnedGame[]> {
	return (await loadGameLibrary(client, steamId, trackedAppIds)).games;
}

export async function getOwnedGamePlaytimes(
	client: SteamUser,
	steamId: string,
	appIds: readonly number[],
): Promise<Map<number, number>> {
	if (appIds.length === 0) {
		return new Map();
	}
	const requestedAppIds = [...new Set(appIds)];
	const playtimes = await getTrackedGamePlaytimes(client).catch(
		() => new Map<number, number>(),
	);
	const missingAppIds = requestedAppIds.filter(
		(appId) => !playtimes.has(appId),
	);
	if (missingAppIds.length > 0) {
		const response = await client.getUserOwnedApps(
			steamId,
			ownedAppsOptions({ filterAppids: missingAppIds }),
		);
		for (const [appId, playtime] of normalizePlaytimes(response.apps)) {
			playtimes.set(appId, playtime);
		}
	}
	return new Map(
		requestedAppIds.flatMap((appId) => {
			const playtime = playtimes.get(appId);
			return playtime === undefined ? [] : [[appId, playtime]];
		}),
	);
}

export function fetchOwnedGamesForLogin(
	refreshToken: string,
	steamId: string,
	machineIdentity: SteamMachineIdentity,
	machineAuthToken?: string | null,
): Promise<OwnedGame[]> {
	const client = new SteamUser({
		autoRelogin: false,
		renewRefreshTokens: false,
		dataDirectory: null,
		enablePicsCache: false,
		machineIdFormat: [...machineIdentity.machineIdFormat],
		machineIdType: SteamUser.EMachineIDType.AccountNameGenerated,
	});

	return new Promise<OwnedGame[]>((resolve, reject) => {
		let settled = false;
		const timeout = setTimeout(
			() => finish(new Error("Steam library loading timed out")),
			LIBRARY_LOGIN_TIMEOUT_MS,
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
					finish(error instanceof Error ? error : new Error(String(error))),
			);
		});
		client.once("error", (error) => finish(error));
		client.once("disconnected", (_result, message) =>
			finish(
				new Error(
					message || "Steam disconnected while loading the game library",
				),
			),
		);

		try {
			client.logOn({
				refreshToken,
				...(machineAuthToken ? { machineAuthToken } : {}),
				machineName: machineIdentity.machineName,
				steamID: steamId,
			});
		} catch (error) {
			finish(error instanceof Error ? error : new Error(String(error)));
		}
	});
}
