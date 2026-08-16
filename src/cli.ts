#!/usr/bin/env node

import { loadConfig } from "./config.js";
import { CredentialVault } from "./crypto.js";
import { AccountStore } from "./database.js";
import { Runner } from "./runner.js";
import { runManagementTui } from "./tui.js";

const command = process.argv[2];

function printHelp(): void {
	process.stdout.write(
		[
			"Linger · multi-account Steam hour booster and card farmer",
			"",
			"Usage:",
			"  linger run       Run all enabled accounts",
			"  linger manage    Open the account management TUI",
			"  linger --help    Show this help",
			"",
		].join("\n"),
	);
}

async function runService(): Promise<void> {
	const config = loadConfig();
	const store = new AccountStore(config.databasePath);
	const runner = new Runner(
		store,
		new CredentialVault(config.masterKey),
		config.steamMachineIdentity,
		config.reconcileIntervalMs,
	);
	let stopping = false;
	const stop = (): void => {
		if (!stopping) {
			stopping = true;
			void runner.stop();
		}
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		await runner.start();
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		store.close();
	}
}

async function manageAccounts(): Promise<void> {
	const config = loadConfig();
	const store = new AccountStore(config.databasePath);
	try {
		await runManagementTui(
			store,
			new CredentialVault(config.masterKey),
			config.steamMachineIdentity,
		);
	} finally {
		store.close();
	}
}

async function main(): Promise<void> {
	switch (command) {
		case "run":
			await runService();
			break;
		case "manage":
			await manageAccounts();
			break;
		case "--help":
		case "-h":
		case undefined:
			printHelp();
			break;
		default:
			throw new Error(`Unknown command: ${command}`);
	}
}

main().catch((error) => {
	process.stderr.write(
		`Linger: ${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
});
