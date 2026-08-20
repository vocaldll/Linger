#!/usr/bin/env node

import { existsSync } from "node:fs";
import { loadConfig, resolveDataPaths } from "./config.js";
import { CredentialVault } from "./crypto.js";
import { AccountStore } from "./database.js";
import { Runner } from "./runner.js";
import { printStatus, watchStatus } from "./status.js";
import { runManagementTui } from "./tui.js";

const [command, ...commandArguments] = process.argv.slice(2);

function printHelp(): void {
	process.stdout.write(
		[
			"Linger · multi-account Steam hour booster and card farmer",
			"",
			"Usage:",
			"  linger run       Run all enabled accounts",
			"  linger manage    Open the account management TUI",
			"  linger status    Show fleet status",
			"  linger --help    Show this help",
			"",
			"Status options:",
			"  --watch          Refresh the dashboard continuously",
			"  --json           Print one machine-readable snapshot",
			"",
		].join("\n"),
	);
}

function printStatusHelp(): void {
	process.stdout.write(
		[
			"Usage: linger status [--watch | --json]",
			"",
			"  --watch    Refresh the dashboard continuously",
			"  --json     Print one machine-readable snapshot",
			"  --help     Show status help",
			"",
		].join("\n"),
	);
}

async function showStatus(): Promise<void> {
	if (
		commandArguments.length === 1 &&
		(commandArguments[0] === "--help" || commandArguments[0] === "-h")
	) {
		printStatusHelp();
		return;
	}
	let watch = false;
	let json = false;
	for (const argument of commandArguments) {
		if (argument === "--watch") {
			watch = true;
		} else if (argument === "--json") {
			json = true;
		} else {
			throw new Error(`Unknown status option: ${argument}`);
		}
	}
	if (watch && json) {
		throw new Error("--watch and --json cannot be used together");
	}
	const { databasePath } = resolveDataPaths();
	if (!existsSync(databasePath)) {
		throw new Error(`No Linger database found at ${databasePath}`);
	}
	const store = new AccountStore(databasePath);
	try {
		if (watch) {
			await watchStatus(store);
		} else {
			printStatus(store, json);
		}
	} finally {
		store.close();
	}
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
		case "status":
			await showStatus();
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
