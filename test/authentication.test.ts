import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { EAuthSessionGuardType, type LoginSession } from "steam-session";
import {
	type AuthenticationInteraction,
	authenticate,
} from "../src/steam/authentication.js";
import { createSteamMachineIdentity } from "../src/steam/machine-identity.js";

class FakeQrSession extends EventEmitter {
	loginTimeout = 0;
	accountName = "vocal";
	refreshToken = "refresh-token";
	steamGuardMachineToken = "";
	steamID = { getSteamID64: () => "76561198000000000" };

	async startWithQR() {
		setImmediate(() => this.emit("authenticated"));
		return {
			qrChallengeUrl: "https://example.invalid/qr",
			actionRequired: true,
			validActions: [{ type: EAuthSessionGuardType.DeviceConfirmation }],
		};
	}

	cancelLoginAttempt(): boolean {
		return true;
	}
}

describe("Steam authentication", () => {
	it("waits for QR authentication without opening a second guard prompt", async () => {
		const session = new FakeQrSession();
		let shownQr: string | null = null;
		let guardChoices = 0;
		const interaction: AuthenticationInteraction = {
			showQrCode(url) {
				shownQr = url;
			},
			async chooseGuard() {
				guardChoices += 1;
				throw new Error("QR login should not ask for a guard method");
			},
			async requestGuardCode() {
				throw new Error("QR login should not ask for a guard code");
			},
			notify() {},
		};

		const result = await authenticate(
			{ type: "qr" },
			interaction,
			createSteamMachineIdentity("authentication-test-device"),
			() => session as unknown as LoginSession,
		);

		assert.equal(shownQr, "https://example.invalid/qr");
		assert.equal(guardChoices, 0);
		assert.equal(result.accountName, "vocal");
	});
});
