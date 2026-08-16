import * as cheerio from "cheerio";
import type { CardFarmingEntry } from "../domain/account.js";

const MAX_BADGE_PAGES = 100;
const PAGE_DELAY_MS = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const APP_ID_PATTERN = /\/gamecards\/(\d+)\/?/u;
const REMAINING_DROPS_PATTERN = /(\d+)\s+card drops? remaining/iu;
const ZERO_DROPS_PATTERN = /(?:no|0)\s+card drops? remaining/iu;

export type CommunityPage = {
	html: string;
	url: string;
};

export type CommunityPageLoader = (
	url: string,
	cookies: readonly string[],
) => Promise<CommunityPage>;

export class SteamCommunityAuthenticationError extends Error {
	constructor() {
		super("Steam Community session is no longer authenticated");
		this.name = "SteamCommunityAuthenticationError";
	}
}

export interface CardCommunity {
	discoverFarmableGames(
		cookies: readonly string[],
	): Promise<CardFarmingEntry[]>;
	getRemainingDrops(cookies: readonly string[], appId: number): Promise<number>;
}

export type ProfileStatus = "in-game" | "online" | "offline" | "unknown";

export interface CommunityProfileStatus {
	getProfileStatus(cookies: readonly string[]): Promise<ProfileStatus>;
}

type BadgePage = {
	entries: CardFarmingEntry[];
	hasNextPage: boolean;
};

export function parseBadgePage(html: string, page: number): BadgePage {
	const $ = cheerio.load(html);
	assertAuthenticated($, "");
	const rows = $(".badge_row");
	if (
		$(".profile_fatalerror, .error_ctn").length > 0 ||
		/there was an error (?:loading|processing)|temporarily unavailable/iu.test(
			$.root().text(),
		)
	) {
		throw new Error(
			"Steam Community returned an error instead of a badges page",
		);
	}
	const looksLikeBadgePage =
		rows.length > 0 ||
		$(".profile_badges, .badges_sheet, .profile_badges_header").length > 0;
	if (!looksLikeBadgePage) {
		throw new Error("Steam Community returned an unrecognized badges page");
	}

	const entries: CardFarmingEntry[] = [];
	rows.each((_index, element) => {
		const row = $(element);
		const href = row.find('a[href*="/gamecards/"]').first().attr("href");
		const appIdMatch = href?.match(APP_ID_PATTERN);
		if (!appIdMatch) {
			return;
		}
		const remainingMatch =
			row.find(".progress_info_bold").text().match(REMAINING_DROPS_PATTERN) ??
			row.text().match(REMAINING_DROPS_PATTERN);
		if (!remainingMatch) {
			if (
				row.find(".badge_title_playgame").length > 0 &&
				!ZERO_DROPS_PATTERN.test(row.text())
			) {
				throw new Error(
					"A farmable Steam badge row did not contain a valid drop count",
				);
			}
			return;
		}
		const remainingDrops = Number(remainingMatch[1]);
		if (remainingDrops > 0) {
			entries.push({ appId: Number(appIdMatch[1]), remainingDrops });
		}
	});

	const nextPage = page + 1;
	const hasNextPage = $("a.pagebtn")
		.toArray()
		.some((element) => {
			const href = $(element).attr("href");
			if (!href) {
				return false;
			}
			try {
				return (
					Number(
						new URL(href, "https://steamcommunity.com").searchParams.get("p"),
					) === nextPage
				);
			} catch {
				return false;
			}
		});
	return { entries, hasNextPage };
}

export function parseRemainingDrops(html: string, appId: number): number {
	const $ = cheerio.load(html);
	assertAuthenticated($, "");
	const emphasizedText = $(".progress_info_bold").text();
	const pageText = $.root().text();
	const match =
		emphasizedText.match(REMAINING_DROPS_PATTERN) ??
		pageText.match(REMAINING_DROPS_PATTERN);
	if (match) {
		return Number(match[1]);
	}
	if (
		ZERO_DROPS_PATTERN.test(emphasizedText) ||
		ZERO_DROPS_PATTERN.test(pageText)
	) {
		return 0;
	}

	const looksLikeCardPage =
		$(
			".badge_card_set_cards, .badge_gamecard_page, .gamecards_inventorylink, .badge_title",
		).length > 0;
	throw new Error(
		looksLikeCardPage
			? `Steam's card page for AppID ${appId} did not contain a drop count`
			: `Steam Community returned an unrecognized card page for AppID ${appId}`,
	);
}

export function parseProfileStatus(html: string): ProfileStatus {
	const $ = cheerio.load(html);
	assertAuthenticated($, "");
	const status = $(".profile_in_game");
	const statusText = status.find(".profile_in_game_header").text().trim();
	if (status.hasClass("in-game") || /currently in-game/iu.test(statusText)) {
		return "in-game";
	}
	if ($(".actual_persona_name").length === 0) {
		return "unknown";
	}
	if (status.hasClass("online") || /currently online/iu.test(statusText)) {
		return "online";
	}
	if (
		status.hasClass("offline") ||
		/^(?:currently )?offline$/iu.test(statusText)
	) {
		return "offline";
	}
	return "unknown";
}

export class SteamCommunityCardService
	implements CardCommunity, CommunityProfileStatus
{
	constructor(
		private readonly loadPage: CommunityPageLoader = loadSteamCommunityPage,
		private readonly wait: (milliseconds: number) => Promise<void> = delay,
	) {}

	async discoverFarmableGames(
		cookies: readonly string[],
	): Promise<CardFarmingEntry[]> {
		const remainingByAppId = new Map<number, number>();
		for (let page = 1; page <= MAX_BADGE_PAGES; page += 1) {
			const response = await this.loadPage(
				`https://steamcommunity.com/my/badges/?l=english&p=${page}`,
				cookies,
			);
			assertResponseAuthenticated(response);
			const parsed = parseBadgePage(response.html, page);
			for (const entry of parsed.entries) {
				remainingByAppId.set(
					entry.appId,
					Math.max(
						entry.remainingDrops,
						remainingByAppId.get(entry.appId) ?? 0,
					),
				);
			}
			if (!parsed.hasNextPage) {
				return [...remainingByAppId.entries()].map(
					([appId, remainingDrops]) => ({
						appId,
						remainingDrops,
					}),
				);
			}
			await this.wait(PAGE_DELAY_MS);
		}
		throw new Error(`Steam badge pagination exceeded ${MAX_BADGE_PAGES} pages`);
	}

	async getRemainingDrops(
		cookies: readonly string[],
		appId: number,
	): Promise<number> {
		const response = await this.loadPage(
			`https://steamcommunity.com/my/gamecards/${appId}/?l=english`,
			cookies,
		);
		assertResponseAuthenticated(response);
		return parseRemainingDrops(response.html, appId);
	}

	async getProfileStatus(cookies: readonly string[]): Promise<ProfileStatus> {
		const response = await this.loadPage(
			"https://steamcommunity.com/my/?l=english",
			cookies,
		);
		assertResponseAuthenticated(response);
		return parseProfileStatus(response.html);
	}
}

async function loadSteamCommunityPage(
	url: string,
	cookies: readonly string[],
): Promise<CommunityPage> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			const response = await fetch(url, {
				headers: {
					Accept: "text/html,application/xhtml+xml",
					"Accept-Language": "en-US,en;q=0.9",
					Cookie: cookies.join("; "),
					"User-Agent": USER_AGENT,
				},
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (response.status === 401 || response.status === 403) {
				throw new SteamCommunityAuthenticationError();
			}
			if (response.status === 429 || response.status >= 500) {
				throw new Error(
					`Steam Community request failed: ${response.status} ${response.statusText}`,
				);
			}
			if (!response.ok) {
				throw new Error(
					`Steam Community request failed: ${response.status} ${response.statusText}`,
				);
			}
			return { html: await response.text(), url: response.url };
		} catch (error) {
			if (error instanceof SteamCommunityAuthenticationError) {
				throw error;
			}
			lastError = error;
			if (attempt < 2) {
				await delay(1_000 * 2 ** attempt);
			}
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function assertResponseAuthenticated(response: CommunityPage): void {
	if (/\/login(?:\/|\?|$)/iu.test(response.url)) {
		throw new SteamCommunityAuthenticationError();
	}
	const $ = cheerio.load(response.html);
	assertAuthenticated($, response.url);
}

function assertAuthenticated($: cheerio.CheerioAPI, url: string): void {
	if ($("#login_form, form[name=logon], .loginbox").length > 0) {
		throw new SteamCommunityAuthenticationError();
	}
	if (url && /\/login(?:\/|\?|$)/iu.test(url)) {
		throw new SteamCommunityAuthenticationError();
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
