import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = process.env.MEMBER_DB_PATH || path.join(DATA_DIR, "members.db");

let db;

function tableColumns(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function runMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      email TEXT,
      email_verified_at INTEGER,
      display_name TEXT NOT NULL DEFAULT 'Guest',
      gender TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      techniques_json TEXT NOT NULL DEFAULT '[]',
      custom_techniques_json TEXT NOT NULL DEFAULT '[]',
      lovense_toys TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS invites (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      host_user_id TEXT NOT NULL,
      invite_code_hash TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      used_by_user_id TEXT,
      FOREIGN KEY (host_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS email_verifications (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id);
  `);

  const userCols = tableColumns(database, "users");
  if (!userCols.includes("email")) {
    database.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
  }
  if (!userCols.includes("email_verified_at")) {
    database.exec(`ALTER TABLE users ADD COLUMN email_verified_at INTEGER`);
    database.exec(`UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL`);
  }
  if (!userCols.includes("lovense_toys")) {
    database.exec(`ALTER TABLE users ADD COLUMN lovense_toys TEXT NOT NULL DEFAULT ''`);
  }
  const profileCols = [
    ["nationality", "TEXT NOT NULL DEFAULT ''"],
    ["languages", "TEXT NOT NULL DEFAULT ''"],
    ["location", "TEXT NOT NULL DEFAULT ''"],
  ];
  let userColsProfile = tableColumns(database, "users");
  for (const [name, type] of profileCols) {
    if (!userColsProfile.includes(name)) {
      database.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
      userColsProfile = tableColumns(database, "users");
    }
  }

  const inviteCols = tableColumns(database, "invites");
  if (!inviteCols.includes("invite_code_hash")) {
    database.exec(`ALTER TABLE invites ADD COLUMN invite_code_hash TEXT`);
  }
  if (!inviteCols.includes("guest_name")) {
    database.exec(`ALTER TABLE invites ADD COLUMN guest_name TEXT NOT NULL DEFAULT ''`);
  }

  const smtpCols = [
    ["smtp_out_host", "TEXT"],
    ["smtp_out_port", "INTEGER"],
    ["smtp_out_secure", "INTEGER NOT NULL DEFAULT 0"],
    ["smtp_out_user", "TEXT"],
    ["smtp_out_pass_enc", "TEXT"],
    ["smtp_from", "TEXT"],
    ["imap_in_host", "TEXT"],
    ["imap_in_port", "INTEGER"],
    ["imap_in_secure", "INTEGER NOT NULL DEFAULT 1"],
    ["imap_in_user", "TEXT"],
  ];
  const userColsFresh = tableColumns(database, "users");
  for (const [name, type] of smtpCols) {
    if (!userColsFresh.includes(name)) {
      database.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
    }
  }

  let userColsAfter = tableColumns(database, "users");
  if (!userColsAfter.includes("account_type")) {
    database.exec(`ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'guest'`);
    userColsAfter = tableColumns(database, "users");
  }
  if (!userColsAfter.includes("is_admin")) {
    database.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`);
  }
  if (!userColsAfter.includes("is_premium")) {
    database.exec(`ALTER TABLE users ADD COLUMN is_premium INTEGER NOT NULL DEFAULT 0`);
  }
  if (!userColsAfter.includes("is_model")) {
    database.exec(`ALTER TABLE users ADD COLUMN is_model INTEGER NOT NULL DEFAULT 0`);
  }
  backfillAccountRoles(database);
}

/** host = can stream as host & invite; guest = invited member; is_admin = SMTP (site admin). */
function backfillAccountRoles(database) {
  database.exec(`UPDATE users SET account_type = 'guest'`);
  database.exec(
    `UPDATE users SET account_type = 'guest' WHERE id IN (SELECT used_by_user_id FROM invites WHERE used_by_user_id IS NOT NULL)`
  );
  database.exec(
    `UPDATE users SET account_type = 'host' WHERE id IN (SELECT DISTINCT host_user_id FROM invites WHERE host_user_id IS NOT NULL)`
  );
  const first = database.prepare(`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`).get();
  if (first?.id) {
    database.prepare(`UPDATE users SET account_type = 'host' WHERE id = ?`).run(first.id);
  }
  const adminNames = String(process.env.ADMIN_USERNAMES || "svenmagnus")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const forcedHostNames = String(process.env.HOST_USERNAMES || "limagno")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const name of adminNames) {
    database
      .prepare(`UPDATE users SET is_admin = 1 WHERE lower(username) = ?`)
      .run(name);
  }
  // Ensure configured host accounts remain host (e.g. Limagno).
  for (const name of forcedHostNames) {
    database
      .prepare(`UPDATE users SET account_type = 'host' WHERE lower(username) = ?`)
      .run(name);
  }
  // Bootstrap: admins are premium by default.
  for (const name of adminNames) {
    database
      .prepare(`UPDATE users SET is_premium = 1 WHERE lower(username) = ?`)
      .run(name);
  }
}

export function initDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  runMigrations(db);
  return db;
}

export function getDb() {
  if (!db) return initDb();
  return db;
}
