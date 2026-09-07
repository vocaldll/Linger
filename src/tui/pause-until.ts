import { input, select } from "@inquirer/prompts";
import { LINGER_THEME } from "./theme.js";

export function parsePauseUntil(value: string, now = Date.now()): string {
	const normalized = value.trim();
	if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u.test(normalized)) {
		throw new Error("Use YYYY-MM-DD HH:mm in local time");
	}
	const date = new Date(`${normalized.replace(" ", "T")}:00`);
	const parts = [
		date.getFullYear(),
		date.getMonth() + 1,
		date.getDate(),
		date.getHours(),
		date.getMinutes(),
	];
	const entered = normalized.split(/[- :]/u).map(Number);
	if (parts.some((part, index) => part !== entered[index])) {
		throw new Error("Enter a valid local date and time");
	}
	if (date.getTime() <= now) {
		throw new Error("Choose a future date and time");
	}
	return date.toISOString();
}

export function formatPauseUntil(until: string): string {
	return new Date(until).toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		timeZoneName: "short",
	});
}

export async function promptPauseUntil(): Promise<string | null> {
	const choice = await select({
		message: "Pause until",
		theme: LINGER_THEME,
		choices: [
			{ name: "In 30 minutes", value: "30" },
			{ name: "In 1 hour", value: "60" },
			{ name: "In 4 hours", value: "240" },
			{ name: "Tomorrow at 09:00 (local time)", value: "tomorrow" },
			{ name: "Choose date and time", value: "custom" },
			{ name: "Back", value: "back" },
		],
	});
	if (choice === "back") return null;
	if (choice === "tomorrow") {
		const date = new Date();
		date.setDate(date.getDate() + 1);
		date.setHours(9, 0, 0, 0);
		return date.toISOString();
	}
	if (choice !== "custom") {
		return new Date(Date.now() + Number(choice) * 60_000).toISOString();
	}
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const value = await input({
		message: `Resume at YYYY-MM-DD HH:mm (${timeZone}; blank cancels)`,
		theme: LINGER_THEME,
		validate(candidate) {
			if (!candidate.trim()) return true;
			try {
				parsePauseUntil(candidate);
				return true;
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		},
	});
	return value.trim() ? parsePauseUntil(value) : null;
}
