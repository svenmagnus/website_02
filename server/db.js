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

  const inviteCols = tableColumns(database, "invites");
  if (!inviteCols.includes("invite_code_hash")) {
    database.exec(`ALTER TABLE invites ADD COLUMN invite_code_hash TEXT`);
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
