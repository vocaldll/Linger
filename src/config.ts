import { mkdirSync, openSync, readFileSync, writeFileSync, closeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

export type AppConfig = {
  dataDir: string;
  databasePath: string;
  masterKey: string;
  reconcileIntervalMs: number;
};

const DEFAULT_RECONCILE_INTERVAL_MS = 2_000;
const MINIMUM_MASTER_KEY_LENGTH = 32;

function readPositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function loadOrCreateMasterKey(dataDir: string): string {
  const configuredFile = process.env.LINGER_MASTER_KEY_FILE?.trim();
  if (configuredFile) {
    const keyPath = path.resolve(configuredFile);
    let value: string;
    try {
      value = readFileSync(keyPath, "utf8").trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`LINGER_MASTER_KEY_FILE does not exist: ${keyPath}`);
      }
      throw error;
    }
    if (value.length < MINIMUM_MASTER_KEY_LENGTH) {
      throw new Error(
        `LINGER_MASTER_KEY_FILE must contain at least ${MINIMUM_MASTER_KEY_LENGTH} characters`
      );
    }
    return value;
  }

  const configured = process.env.LINGER_MASTER_KEY?.trim();
  if (configured) {
    if (configured.length < MINIMUM_MASTER_KEY_LENGTH) {
      throw new Error(
        `LINGER_MASTER_KEY must be at least ${MINIMUM_MASTER_KEY_LENGTH} characters long`
      );
    }
    return configured;
  }

  const keyPath = path.join(dataDir, "master.key");
  try {
    const existing = readFileSync(keyPath, "utf8").trim();
    if (!existing) {
      throw new Error(`Encryption key is empty: ${keyPath}`);
    }
    return existing;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const generated = randomBytes(32).toString("base64url");
  try {
    const fd = openSync(keyPath, "wx", 0o600);
    try {
      writeFileSync(fd, `${generated}\n`, "utf8");
    } finally {
      closeSync(fd);
    }
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return readFileSync(keyPath, "utf8").trim();
    }
    throw error;
  }
}

export function loadConfig(): AppConfig {
  const dataDir = path.resolve(process.env.LINGER_DATA_DIR ?? path.join(process.cwd(), "data"));
  mkdirSync(dataDir, { recursive: true });

  return {
    dataDir,
    databasePath: path.resolve(process.env.LINGER_DB_PATH ?? path.join(dataDir, "linger.sqlite")),
    masterKey: loadOrCreateMasterKey(dataDir),
    reconcileIntervalMs: readPositiveInteger(
      process.env.LINGER_RECONCILE_INTERVAL_MS,
      DEFAULT_RECONCILE_INTERVAL_MS,
      "LINGER_RECONCILE_INTERVAL_MS"
    )
  };
}
