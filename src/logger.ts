import type { Writable } from "node:stream";
import { PALETTE } from "./theme.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSubsystem = "runner" | "steam" | "presence" | "library" | "cards";
export type LogFields = Record<string, boolean | number | string | null | undefined>;

const priorities: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function ansiTrueColor(hex: `#${string}`): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `\u001b[38;2;${red};${green};${blue}m`;
}

const levelColors: Record<LogLevel, string> = {
  debug: "\u001b[90m",
  info: ansiTrueColor(PALETTE.violet),
  warn: "\u001b[33m",
  error: "\u001b[31m"
};
const RESET = "\u001b[0m";
const DIM = "\u001b[2m";
const ACCOUNT_COLOR = ansiTrueColor(PALETTE.lilac);
const SUBSYSTEM_COLOR = ansiTrueColor(PALETTE.mist);

function configuredThreshold(): number {
  const level = (process.env.LINGER_LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return priorities[level] ?? priorities.info;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatTimestamp(date: Date): string {
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds())
  ].join("");
}

function sanitizeMessage(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
}

function formatValue(value: Exclude<LogFields[string], undefined>): string {
  if (typeof value === "string") {
    return /^[\p{L}\p{N}._:/@+\-]+$/u.test(value) ? value : JSON.stringify(value);
  }
  return String(value);
}

function formatFields(fields: LogFields, color: boolean): string {
  return Object.entries(fields)
    .filter((entry): entry is [string, Exclude<LogFields[string], undefined>] => entry[1] !== undefined)
    .map(([key, value]) => {
      const label = `${key}=`;
      return color ? `${DIM}${label}${RESET}${formatValue(value)}` : `${label}${formatValue(value)}`;
    })
    .join(" ");
}

export function formatLogLine(
  level: LogLevel,
  subsystem: LogSubsystem,
  message: string,
  fields: LogFields = {},
  options: { color?: boolean; date?: Date } = {}
): string {
  const color = options.color ?? false;
  const timestamp = `[${formatTimestamp(options.date ?? new Date())}]`;
  const label = level.toUpperCase().padEnd(5);
  const account = typeof fields.account === "string" && fields.account
    ? sanitizeMessage(fields.account)
    : "—";
  const accountColumn = account.padEnd(12);
  const subsystemColumn = subsystem.padEnd(8);
  const details = formatFields(
    Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "account")),
    color
  );
  const separator = details ? (color ? ` ${DIM}│${RESET} ` : " | ") : "";

  if (!color) {
    return `${timestamp} ${label} ${accountColumn} ${subsystemColumn} ${sanitizeMessage(message)}${separator}${details}`;
  }

  return `${DIM}${timestamp}${RESET} ${levelColors[level]}${label}${RESET} ${ACCOUNT_COLOR}${accountColumn}${RESET} ${SUBSYSTEM_COLOR}${subsystemColumn}${RESET} ${sanitizeMessage(message)}${separator}${details}`;
}

function shouldUseColor(stream: Writable): boolean {
  if (process.env.NO_COLOR !== undefined || process.env.FORCE_COLOR === "0") {
    return false;
  }
  if (process.env.FORCE_COLOR !== undefined) {
    return true;
  }
  return Boolean((stream as Writable & { isTTY?: boolean }).isTTY);
}

function write(
  level: LogLevel,
  subsystem: LogSubsystem,
  message: string,
  fields: LogFields = {}
): void {
  if (priorities[level] < configuredThreshold()) {
    return;
  }

  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`${formatLogLine(level, subsystem, message, fields, { color: shouldUseColor(stream) })}\n`);
}

export const logger = {
  debug: (subsystem: LogSubsystem, message: string, fields?: LogFields) =>
    write("debug", subsystem, message, fields),
  info: (subsystem: LogSubsystem, message: string, fields?: LogFields) =>
    write("info", subsystem, message, fields),
  warn: (subsystem: LogSubsystem, message: string, fields?: LogFields) =>
    write("warn", subsystem, message, fields),
  error: (subsystem: LogSubsystem, message: string, fields?: LogFields) =>
    write("error", subsystem, message, fields)
};
