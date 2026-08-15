import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parseBadgePage,
	parseProfileStatus,
	parseRemainingDrops,
	SteamCommunityAuthenticationError,
	SteamCommunityCardService,
} from "../src/steam/community-cards.js";

const badgeShell = (rows: string, pagination = ""): string => `
  <html><body><div class="profile_badges"><div class="badges_sheet">
    ${rows}
    ${pagination}
  </div></div></body></html>
`;

const badgeRow = (appId: number, drops: number): string => `
  <div class="badge_row">
    <a href="https://steamcommunity.com/my/gamecards/${appId}/">cards</a>
    <div class="progress_info_bold">${drops} card drops remaining</div>
  </div>
`;

describe("Steam Community card pages", () => {
	it("parses drop counts and follows explicit badge pagination", async () => {
		const requested: string[] = [];
		const service = new SteamCommunityCardService(
			async (url) => {
				requested.push(url);
				return {
					url,
					html: url.includes("p=1")
						? badgeShell(
								badgeRow(730, 2),
								'<a class="pagebtn" href="/my/badges/?p=2">next</a>',
							)
						: badgeShell(`${badgeRow(440, 1)}${badgeRow(730, 1)}`),
				};
			},
			async () => {},
		);

		assert.deepEqual(await service.discoverFarmableGames(["session=secret"]), [
			{ appId: 730, remainingDrops: 2 },
			{ appId: 440, remainingDrops: 1 },
		]);
		assert.equal(requested.length, 2);
	});

	it("recognizes explicit zero drops but rejects unknown card pages", () => {
		assert.equal(
			parseRemainingDrops(
				'<div class="badge_gamecard_page"><div class="progress_info_bold">No card drops remaining</div></div>',
				730,
			),
			0,
		);
		assert.throws(
			() =>
				parseRemainingDrops(
					'<div class="badge_gamecard_page">temporarily unavailable</div>',
					730,
				),
			/did not contain a drop count/iu,
		);
	});

	it("never treats a login page as an empty farming result", () => {
		assert.throws(
			() => parseBadgePage('<form id="login_form"></form>', 1),
			SteamCommunityAuthenticationError,
		);
	});

	it("classifies explicit profile status", () => {
		assert.equal(
			parseProfileStatus(`
				<div class="actual_persona_name">alice</div>
				<div class="profile_in_game persona in-game">
					<div class="profile_in_game_header">Currently In-Game</div>
				</div>
			`),
			"in-game",
		);
		assert.equal(
			parseProfileStatus(`
				<div class="actual_persona_name">alice</div>
				<div class="profile_in_game persona online">
					<div class="profile_in_game_header">Currently Online</div>
				</div>
			`),
			"online",
		);
		assert.equal(
			parseProfileStatus(`
				<div class="actual_persona_name">alice</div>
				<div class="profile_in_game persona offline">
					<div class="profile_in_game_header">Currently Offline</div>
					<div class="profile_in_game_name">Last Online 15 mins ago</div>
				</div>
			`),
			"offline",
		);
	});

	it("treats private and status-less profiles as unknown", () => {
		assert.equal(
			parseProfileStatus(
				'<div class="profile_private_info">This profile is private.</div>',
			),
			"unknown",
		);
		assert.equal(
			parseProfileStatus('<div class="actual_persona_name">alice</div>'),
			"unknown",
		);
	});

	it("checks the authenticated account profile directly", async () => {
		const requested: string[] = [];
		let receivedCookies: readonly string[] = [];
		const service = new SteamCommunityCardService(async (url, cookies) => {
			requested.push(url);
			receivedCookies = cookies;
			return {
				url,
				html: `
					<div class="actual_persona_name">alice</div>
					<div class="profile_in_game persona offline">
						<div class="profile_in_game_header">Offline</div>
					</div>
				`,
			};
		});

		assert.equal(await service.getProfileStatus(["session=secret"]), "offline");
		assert.equal(requested.length, 1);
		assert.match(requested[0] ?? "", /\/my\/\?l=english$/iu);
		assert.deepEqual(receivedCookies, ["session=secret"]);
	});

	it("rejects a recognizable farmable row when its drop count cannot be parsed", () => {
		assert.throws(
			() =>
				parseBadgePage(
					badgeShell(`
            <div class="badge_row">
              <a href="/my/gamecards/730/">cards</a>
              <a class="badge_title_playgame">Play Game</a>
              <div class="progress_info_bold">drop data unavailable</div>
            </div>
          `),
					1,
				),
			/did not contain a valid drop count/iu,
		);
	});
});
