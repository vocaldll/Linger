import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  Account,
  AccountConfiguration,
  AccountStatus,
  NewAccount,
  RuntimePatch
} from "./domain/account.js";
import { validatePresence } from "./domain/account.js";

type AccountRow = {
  id: string;
  account_name: string;
  steam_id: string | null;
  refresh_token_encrypted: string;
  machine_auth_token_encrypted: string | null;
  app_ids_json: string;
  custom_game: string | null;
  visible: number;
  enabled: number;
  revision: number;
  restart_nonce: number;
  status: AccountStatus;
  last_error: string | null;
  last_connected_at: string | null;
  created_at: string;
  updated_at: string;
};

const ACCOUNT_COLUMNS = `
  id, account_name, steam_id, refresh_token_encrypted, machine_auth_token_encrypted,
  app_ids_json, custom_game, visible, enabled, revision, restart_nonce, status,
  last_error, last_connected_at, created_at, updated_at
`;

function parseAppIdsJson(value: string): number[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => Number.isSafeInteger(item) && item > 0)) {
    throw new Error("Stored account has invalid AppIDs");
  }
  return parsed as number[];
}

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    accountName: row.account_name,
    steamId: row.steam_id,
    refreshTokenEncrypted: row.refresh_token_encrypted,
    machineAuthTokenEncrypted: row.machine_auth_token_encrypted,
    appIds: parseAppIdsJson(row.app_ids_json),
    customGame: row.custom_game,
    visible: row.visible === 1,
    enabled: row.enabled === 1,
    revision: row.revision,
    restartNonce: row.restart_nonce,
    status: row.status,
    lastError: row.last_error,
    lastConnectedAt: row.last_connected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class AccountStore {
  readonly #db: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.#db = new DatabaseSync(databasePath);
    this.#db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.#migrate();
  }

  close(): void {
    this.#db.close();
  }

  list(): Account[] {
    const rows = this.#db
      .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY account_name COLLATE NOCASE`)
      .all() as AccountRow[];
    return rows.map(mapAccount);
  }

  get(id: string): Account | null {
    const row = this.#db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`).get(id) as
      | AccountRow
      | undefined;
    return row ? mapAccount(row) : null;
  }

  getByName(accountName: string): Account | null {
    const row = this.#db
      .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE account_name = ? COLLATE NOCASE`)
      .get(accountName) as AccountRow | undefined;
    return row ? mapAccount(row) : null;
  }

  create(input: NewAccount): Account {
    validatePresence(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db
      .prepare(`
        INSERT INTO accounts (
          id, account_name, steam_id, refresh_token_encrypted, machine_auth_token_encrypted,
          app_ids_json, custom_game, visible, enabled, revision, restart_nonce, status,
          last_error, last_connected_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, NULL, NULL, ?, ?)
      `)
      .run(
        id,
        input.accountName,
        input.steamId,
        input.refreshTokenEncrypted,
        input.machineAuthTokenEncrypted,
        JSON.stringify(input.appIds),
        input.customGame?.trim() || null,
        input.visible ? 1 : 0,
        input.enabled ? 1 : 0,
        input.enabled ? "idle" : "disabled",
        now,
        now
      );
    return this.#require(id);
  }

  updateConfiguration(id: string, configuration: AccountConfiguration): Account {
    validatePresence(configuration);
    const result = this.#db
      .prepare(`
        UPDATE accounts
        SET app_ids_json = ?, custom_game = ?, visible = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `)
      .run(
        JSON.stringify(configuration.appIds),
        configuration.customGame?.trim() || null,
        configuration.visible ? 1 : 0,
        new Date().toISOString(),
        id
      );
    this.#assertChanged(result.changes, id);
    return this.#require(id);
  }

  setEnabled(id: string, enabled: boolean): Account {
    const result = this.#db
      .prepare(`
        UPDATE accounts
        SET enabled = ?, status = ?, last_error = NULL, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `)
      .run(enabled ? 1 : 0, enabled ? "idle" : "disabled", new Date().toISOString(), id);
    this.#assertChanged(result.changes, id);
    return this.#require(id);
  }

  requestRestart(id: string): Account {
    const result = this.#db
      .prepare("UPDATE accounts SET restart_nonce = restart_nonce + 1, revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    this.#assertChanged(result.changes, id);
    return this.#require(id);
  }

  replaceCredentials(
    id: string,
    credentials: Pick<Account, "accountName" | "steamId" | "refreshTokenEncrypted" | "machineAuthTokenEncrypted">
  ): Account {
    const result = this.#db
      .prepare(`
        UPDATE accounts SET
          account_name = ?, steam_id = ?, refresh_token_encrypted = ?, machine_auth_token_encrypted = ?,
          status = ?, last_error = NULL, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `)
      .run(
        credentials.accountName,
        credentials.steamId,
        credentials.refreshTokenEncrypted,
        credentials.machineAuthTokenEncrypted,
        "idle",
        new Date().toISOString(),
        id
      );
    this.#assertChanged(result.changes, id);
    return this.#require(id);
  }

  updateRuntime(id: string, patch: RuntimePatch): Account {
    const entries = Object.entries({
      steam_id: patch.steamId,
      status: patch.status,
      last_error: patch.lastError,
      last_connected_at: patch.lastConnectedAt,
      refresh_token_encrypted: patch.refreshTokenEncrypted,
      machine_auth_token_encrypted: patch.machineAuthTokenEncrypted
    }).filter((entry) => entry[1] !== undefined);
    if (entries.length === 0) {
      return this.#require(id);
    }

    const assignments = entries.map(([column]) => `${column} = ?`).join(", ");
    const values = entries.map(([, value]) => value as string | null);
    const result = this.#db
      .prepare(`UPDATE accounts SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...values, new Date().toISOString(), id);
    this.#assertChanged(result.changes, id);
    return this.#require(id);
  }

  delete(id: string): void {
    const result = this.#db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    this.#assertChanged(result.changes, id);
  }

  resetInterruptedStatuses(): void {
    this.#db
      .prepare(`
        UPDATE accounts
        SET status = CASE WHEN enabled = 1 THEN 'idle' ELSE 'disabled' END
        WHERE status IN ('connecting', 'online', 'backoff')
      `)
      .run();
  }

  claimRunner(ownerId: string, staleAfterMs = 30_000): boolean {
    const now = Date.now();
    const result = this.#db.prepare(`
      INSERT INTO runner_lease (singleton, owner_id, heartbeat_at)
      VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET owner_id = excluded.owner_id, heartbeat_at = excluded.heartbeat_at
      WHERE runner_lease.owner_id = excluded.owner_id OR runner_lease.heartbeat_at < ?
    `).run(ownerId, now, now - staleAfterMs);
    return result.changes > 0;
  }

  heartbeatRunner(ownerId: string): void {
    const result = this.#db
      .prepare("UPDATE runner_lease SET heartbeat_at = ? WHERE singleton = 1 AND owner_id = ?")
      .run(Date.now(), ownerId);
    if (result.changes === 0) {
      throw new Error("Linger runner lost its database lease");
    }
  }

  releaseRunner(ownerId: string): void {
    this.#db.prepare("DELETE FROM runner_lease WHERE singleton = 1 AND owner_id = ?").run(ownerId);
  }

  #require(id: string): Account {
    const account = this.get(id);
    if (!account) {
      throw new Error(`Account not found: ${id}`);
    }
    return account;
  }

  #assertChanged(changes: number | bigint, id: string): void {
    if (changes === 0 || changes === 0n) {
      throw new Error(`Account not found: ${id}`);
    }
  }

  #migrate(): void {
    const versionRow = this.#db.prepare("PRAGMA user_version").get() as { user_version: number };
    const version = versionRow.user_version;
    if (version > 2) {
      throw new Error(`Database schema ${version} is newer than this version of Linger supports`);
    }
    if (version === 0) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
      this.#db.exec(`
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          account_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
          steam_id TEXT,
          refresh_token_encrypted TEXT NOT NULL,
          machine_auth_token_encrypted TEXT,
          app_ids_json TEXT NOT NULL,
          custom_game TEXT,
          visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          revision INTEGER NOT NULL,
          restart_nonce INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('disabled', 'idle', 'connecting', 'online', 'backoff', 'needs_auth', 'error')),
          last_error TEXT,
          last_connected_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        PRAGMA user_version = 1;
      `);
      this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }

    if (version <= 1) {
      this.#db.exec(`
        CREATE TABLE runner_lease (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          owner_id TEXT NOT NULL,
          heartbeat_at INTEGER NOT NULL
        );
        PRAGMA user_version = 2;
      `);
    }
  }
}
