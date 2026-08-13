import type { Writable } from "node:stream";
import { PALETTE } from "./theme.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
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
  message: string,
  fields: LogFields = {},
  options: { color?: boolean; date?: Date } = {}
): string {
  const color = options.color ?? false;
  const timestamp = `[${formatTimestamp(options.date ?? new Date())}]`;
  const label = level.toUpperCase().padEnd(5);
  const details = formatFields(fields, color);
  const separator = details ? (color ? ` ${DIM}│${RESET} ` : " | ") : "";

  if (!color) {
    return `${timestamp} ${label} ${sanitizeMessage(message)}${separator}${details}`;
  }

  return `${DIM}${timestamp}${RESET} ${levelColors[level]}${label}${RESET} ${sanitizeMessage(message)}${separator}${details}`;
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

function write(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (priorities[level] < configuredThreshold()) {
    return;
  }

  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`${formatLogLine(level, message, fields, { color: shouldUseColor(stream) })}\n`);
}

export const logger = {
  debug: (message: string, fields?: LogFields) => write("debug", message, fields),
  info: (message: string, fields?: LogFields) => write("info", message, fields),
  warn: (message: string, fields?: LogFields) => write("warn", message, fields),
  error: (message: string, fields?: LogFields) => write("error", message, fields)
};
