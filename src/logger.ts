type LogLevel = "debug" | "info" | "warn" | "error";
type Fields = Record<string, boolean | number | string | null | undefined>;

const priorities: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const configuredLevel = (process.env.LINGER_LOG_LEVEL ?? "info") as LogLevel;
const threshold = priorities[configuredLevel] ?? priorities.info;

function write(level: LogLevel, message: string, fields: Fields = {}): void {
  if (priorities[level] < threshold) {
    return;
  }

  const details = Object.entries(fields)
    .filter((entry) => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${details ? ` ${details}` : ""}\n`;
  (level === "error" ? process.stderr : process.stdout).write(line);
}

export const logger = {
  debug: (message: string, fields?: Fields) => write("debug", message, fields),
  info: (message: string, fields?: Fields) => write("info", message, fields),
  warn: (message: string, fields?: Fields) => write("warn", message, fields),
  error: (message: string, fields?: Fields) => write("error", message, fields)
};
