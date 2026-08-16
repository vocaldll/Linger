import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	createSteamMachineIdentity,
	loadOrCreateSteamMachineIdentity,
} from "../src/steam/machine-identity.js";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
	const directory = mkdtempSync(path.join(tmpdir(), "steam-identity-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Steam machine identity", () => {
	it("creates and reuses a random identity for one data directory", () => {
		const directory = createTemporaryDirectory();

		const first = loadOrCreateSteamMachineIdentity(directory);
		const second = loadOrCreateSteamMachineIdentity(directory);

		assert.deepEqual(second, first);
		assert.equal(first.machineId.length, 155);
		assert.match(first.machineName, /^DESKTOP-[A-Z]{7}$/u);
		assert.equal(
			readFileSync(path.join(directory, "steam-device-id"), "utf8").trim()
				.length,
			43,
		);
	});

	it("creates different identities for different data directories", () => {
		const first = loadOrCreateSteamMachineIdentity(createTemporaryDirectory());
		const second = loadOrCreateSteamMachineIdentity(createTemporaryDirectory());

		assert.notDeepEqual(second.machineId, first.machineId);
	});

	it("derives every transmitted value from the local random identifier", () => {
		const identity = createSteamMachineIdentity("local-random-device-id");

		assert.deepEqual(
			createSteamMachineIdentity("local-random-device-id"),
			identity,
		);
		assert.notDeepEqual(
			createSteamMachineIdentity("another-local-device-id").machineId,
			identity.machineId,
		);
		assert.equal(
			identity.machineId.includes(Buffer.from("local-random-device-id")),
			false,
		);
	});

	it("rejects a malformed persisted identifier", () => {
		const directory = createTemporaryDirectory();
		writeFileSync(path.join(directory, "steam-device-id"), "invalid\n", "utf8");

		assert.throws(
			() => loadOrCreateSteamMachineIdentity(directory),
			/Steam device identity is invalid/iu,
		);
	});
});
