import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEVICE_ID_FILE = "steam-device-id";
const DEVICE_ID_BYTES = 32;
const MACHINE_NAME_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export type SteamMachineIdentity = {
	machineId: Buffer;
	machineIdFormat: [string, string, string];
	machineName: string;
};

function readDeviceId(deviceIdPath: string): string {
	const deviceId = readFileSync(deviceIdPath, "utf8").trim();
	const decoded = Buffer.from(deviceId, "base64url");
	if (
		decoded.length !== DEVICE_ID_BYTES ||
		decoded.toString("base64url") !== deviceId
	) {
		throw new Error(`Steam device identity is invalid: ${deviceIdPath}`);
	}
	return deviceId;
}

function loadOrCreateDeviceId(dataDir: string): string {
	const deviceIdPath = path.join(dataDir, DEVICE_ID_FILE);
	try {
		return readDeviceId(deviceIdPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}

	const generated = randomBytes(DEVICE_ID_BYTES).toString("base64url");
	try {
		const fd = openSync(deviceIdPath, "wx", 0o600);
		try {
			writeFileSync(fd, `${generated}\n`, "utf8");
		} finally {
			closeSync(fd);
		}
		return generated;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return readDeviceId(deviceIdPath);
		}
		throw error;
	}
}

function sha1(value: string): string {
	return createHash("sha1").update(value, "utf8").digest("hex");
}

function cString(value: string): Buffer {
	return Buffer.from(`${value}\0`, "utf8");
}

function encodeMachineId(format: readonly [string, string, string]): Buffer {
	return Buffer.concat([
		Buffer.from([0]),
		cString("MessageObject"),
		Buffer.from([1]),
		cString("BB3"),
		cString(sha1(format[0])),
		Buffer.from([1]),
		cString("FF2"),
		cString(sha1(format[1])),
		Buffer.from([1]),
		cString("3B3"),
		cString(sha1(format[2])),
		Buffer.from([8, 8]),
	]);
}

function createMachineName(deviceId: string): string {
	const hash = createHash("sha256").update(deviceId, "utf8").digest();
	let suffix = "";
	for (let index = 0; index < 7; index += 1) {
		suffix += MACHINE_NAME_CHARACTERS.charAt(
			hash.readUInt8(index) % MACHINE_NAME_CHARACTERS.length,
		);
	}
	return `DESKTOP-${suffix}`;
}

export function createSteamMachineIdentity(
	deviceId: string,
): SteamMachineIdentity {
	const machineIdFormat: [string, string, string] = [
		`Steam Device BB3 ${deviceId}`,
		`Steam Device FF2 ${deviceId}`,
		`Steam Device 3B3 ${deviceId}`,
	];
	return {
		machineId: encodeMachineId(machineIdFormat),
		machineIdFormat,
		machineName: createMachineName(deviceId),
	};
}

export function loadOrCreateSteamMachineIdentity(
	dataDir: string,
): SteamMachineIdentity {
	return createSteamMachineIdentity(loadOrCreateDeviceId(dataDir));
}
