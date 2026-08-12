import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadConfig } from "../src/config.js";

const ORIGINAL_ENVIRONMENT = {
  LINGER_DATA_DIR: process.env.LINGER_DATA_DIR,
  LINGER_DB_PATH: process.env.LINGER_DB_PATH,
  LINGER_MASTER_KEY: process.env.LINGER_MASTER_KEY,
  LINGER_MASTER_KEY_FILE: process.env.LINGER_MASTER_KEY_FILE,
  LINGER_RECONCILE_INTERVAL_MS: process.env.LINGER_RECONCILE_INTERVAL_MS
};
const temporaryDirectories: string[] = [];

function restoreEnvironment(): void {
  for (const [name, value] of Object.entries(ORIGINAL_ENVIRONMENT)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "linger-config-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  restoreEnvironment();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("master key configuration", () => {
  it("prefers a configured secret file over an inline key", () => {
    const directory = createTemporaryDirectory();
    const secretPath = path.join(directory, "docker-secret");
    const secret = "file-backed-master-key-with-enough-entropy";
    writeFileSync(secretPath, `${secret}\n`, "utf8");
    process.env.LINGER_DATA_DIR = path.join(directory, "data");
    process.env.LINGER_MASTER_KEY_FILE = secretPath;
    process.env.LINGER_MASTER_KEY = "inline-master-key-that-is-also-long-enough";

    const config = loadConfig();

    assert.equal(config.masterKey, secret);
    assert.equal(existsSync(path.join(config.dataDir, "master.key")), false);
  });

  it("uses the inline key when no secret file is configured", () => {
    const directory = createTemporaryDirectory();
    const secret = "inline-master-key-that-is-long-enough";
    process.env.LINGER_DATA_DIR = directory;
    delete process.env.LINGER_MASTER_KEY_FILE;
    process.env.LINGER_MASTER_KEY = secret;

    assert.equal(loadConfig().masterKey, secret);
    assert.equal(existsSync(path.join(directory, "master.key")), false);
  });

  it("creates and reuses a local key as the final fallback", () => {
    const directory = createTemporaryDirectory();
    process.env.LINGER_DATA_DIR = directory;
    delete process.env.LINGER_MASTER_KEY_FILE;
    delete process.env.LINGER_MASTER_KEY;

    const first = loadConfig().masterKey;
    const second = loadConfig().masterKey;

    assert.equal(first.length >= 32, true);
    assert.equal(second, first);
    assert.equal(existsSync(path.join(directory, "master.key")), true);
  });

  it("fails clearly instead of falling back when a configured secret file is unavailable", () => {
    const directory = createTemporaryDirectory();
    const missingPath = path.join(directory, "missing-secret");
    process.env.LINGER_DATA_DIR = path.join(directory, "data");
    process.env.LINGER_MASTER_KEY_FILE = missingPath;
    process.env.LINGER_MASTER_KEY = "inline-master-key-that-would-otherwise-work";

    assert.throws(() => loadConfig(), /LINGER_MASTER_KEY_FILE does not exist/iu);
  });

  it("rejects weak file-backed keys", () => {
    const directory = createTemporaryDirectory();
    const secretPath = path.join(directory, "weak-secret");
    writeFileSync(secretPath, "too-short\n", "utf8");
    process.env.LINGER_DATA_DIR = path.join(directory, "data");
    process.env.LINGER_MASTER_KEY_FILE = secretPath;

    assert.throws(() => loadConfig(), /must contain at least 32 characters/iu);
  });
});
