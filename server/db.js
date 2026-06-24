import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
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

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
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
  if (!userCols.includes("whip_stream_key")) {
    database.exec(`ALTER TABLE users ADD COLUMN whip_stream_key TEXT`);
    database.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_whip_stream_key ON users(whip_stream_key) WHERE whip_stream_key IS NOT NULL`
    );
  }
  if (!userCols.includes("appearance_theme")) {
    database.exec(`ALTER TABLE users ADD COLUMN appearance_theme TEXT NOT NULL DEFAULT 'neon'`);
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
  userColsAfter = tableColumns(database, "users");
  if (!userColsAfter.includes("chat_colors_json")) {
    database.exec(`ALTER TABLE users ADD COLUMN chat_colors_json TEXT`);
  }
  userColsAfter = tableColumns(database, "users");
  if (!userColsAfter.includes("play_mode_sound")) {
    database.exec(`ALTER TABLE users ADD COLUMN play_mode_sound TEXT`);
  }
  userColsAfter = tableColumns(database, "users");
  if (!userColsAfter.includes("banned_at")) {
    database.exec(`ALTER TABLE users ADD COLUMN banned_at INTEGER`);
  }
  if (!userColsAfter.includes("ban_reason")) {
    database.exec(`ALTER TABLE users ADD COLUMN ban_reason TEXT NOT NULL DEFAULT ''`);
  }
  userColsAfter = tableColumns(database, "users");
  if (!userColsAfter.includes("subscription_override")) {
    database.exec(`ALTER TABLE users ADD COLUMN subscription_override TEXT NOT NULL DEFAULT ''`);
  }
  userColsAfter = tableColumns(database, "users");
  if (!userColsAfter.includes("is_free_guest")) {
    database.exec(`ALTER TABLE users ADD COLUMN is_free_guest INTEGER NOT NULL DEFAULT 0`);
    database.exec(
      `UPDATE users SET is_free_guest = 1, is_premium = 0
       WHERE is_premium = 1 AND is_model = 0 AND is_admin = 0`
    );
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS chat_threads (
      id TEXT PRIMARY KEY,
      user_low_id TEXT NOT NULL,
      user_high_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_low_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (user_high_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE (user_low_id, user_high_id)
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      sender_user_id TEXT NOT NULL,
      body TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      host_user_id TEXT NOT NULL,
      guest_user_id TEXT,
      thread_id TEXT,
      mode TEXT NOT NULL DEFAULT 'instant'
        CHECK (mode IN ('instant', 'scheduled')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'scheduled', 'live', 'completed', 'cancelled')),
      host_peer_id TEXT NOT NULL DEFAULT '',
      scheduled_start_at INTEGER,
      scheduled_end_at INTEGER,
      calendar_url TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (host_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (guest_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_meetings_host ON meetings(host_user_id);
    CREATE INDEX IF NOT EXISTS idx_meetings_guest ON meetings(guest_user_id);
  `);

  const oauthCols = [
    ["google_refresh_token_enc", "TEXT NOT NULL DEFAULT ''"],
    ["google_calendar_email", "TEXT NOT NULL DEFAULT ''"],
    ["google_calendar_connected_at", "INTEGER"],
  ];
  let userColsOAuth = tableColumns(database, "users");
  for (const [name, type] of oauthCols) {
    if (!userColsOAuth.includes(name)) {
      database.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
      userColsOAuth = tableColumns(database, "users");
    }
  }

  const meetingCols = tableColumns(database, "meetings");
  if (meetingCols.length && !meetingCols.includes("google_event_id")) {
    database.exec(`ALTER TABLE meetings ADD COLUMN google_event_id TEXT NOT NULL DEFAULT ''`);
  }
  if (meetingCols.length && !meetingCols.includes("created_by_user_id")) {
    database.exec(`ALTER TABLE meetings ADD COLUMN created_by_user_id TEXT`);
  }
  if (meetingCols.length && !meetingCols.includes("peer_user_id")) {
    database.exec(`ALTER TABLE meetings ADD COLUMN peer_user_id TEXT NOT NULL DEFAULT ''`);
  }

  let userColsPresence = tableColumns(database, "users");
  if (!userColsPresence.includes("last_seen_at")) {
    database.exec(`ALTER TABLE users ADD COLUMN last_seen_at INTEGER`);
    userColsPresence = tableColumns(database, "users");
  }
  if (!userColsPresence.includes("avatar_path")) {
    database.exec(`ALTER TABLE users ADD COLUMN avatar_path TEXT NOT NULL DEFAULT ''`);
    userColsPresence = tableColumns(database, "users");
  }
  if (!userColsPresence.includes("avatar_updated_at")) {
    database.exec(`ALTER TABLE users ADD COLUMN avatar_updated_at INTEGER`);
    userColsPresence = tableColumns(database, "users");
  }
  if (!userColsPresence.includes("play_prefs_json")) {
    database.exec(`ALTER TABLE users ADD COLUMN play_prefs_json TEXT NOT NULL DEFAULT '{}'`);
    userColsPresence = tableColumns(database, "users");
  }
  if (!userColsPresence.includes("custom_menus_json")) {
    database.exec(
      `ALTER TABLE users ADD COLUMN custom_menus_json TEXT NOT NULL DEFAULT '{"menus":[],"enabled":[]}'`
    );
    userColsPresence = tableColumns(database, "users");
  }
  if (!userColsPresence.includes("age")) {
    database.exec(`ALTER TABLE users ADD COLUMN age INTEGER`);
    userColsPresence = tableColumns(database, "users");
  }
  if (!userColsPresence.includes("body_type")) {
    database.exec(`ALTER TABLE users ADD COLUMN body_type TEXT NOT NULL DEFAULT ''`);
    userColsPresence = tableColumns(database, "users");
  }
  if (!userColsPresence.includes("interested_in")) {
    database.exec(`ALTER TABLE users ADD COLUMN interested_in TEXT NOT NULL DEFAULT ''`);
    userColsPresence = tableColumns(database, "users");
  }
  if (!userColsPresence.includes("profile_gallery_json")) {
    database.exec(`ALTER TABLE users ADD COLUMN profile_gallery_json TEXT NOT NULL DEFAULT '[]'`);
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS model_pool (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      model_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      registered_at INTEGER,
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (model_user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE (owner_user_id, model_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_model_pool_owner ON model_pool(owner_user_id);

    CREATE TABLE IF NOT EXISTS session_members (
      user_id TEXT NOT NULL,
      member_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, member_user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (member_user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_session_members_user ON session_members(user_id);
  `);

  backfillModelPool(database);
  backfillAccountRoles(database);

  database.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id TEXT PRIMARY KEY,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      status TEXT NOT NULL DEFAULT 'none',
      trial_ends_at INTEGER,
      current_period_end INTEGER,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer ON subscriptions(stripe_customer_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
  `);

  let subCols = tableColumns(database, "subscriptions");
  if (!subCols.includes("subscription_tier")) {
    database.exec(`ALTER TABLE subscriptions ADD COLUMN subscription_tier TEXT`);
    subCols = tableColumns(database, "subscriptions");
  }
  if (!subCols.includes("premium_one_time_at")) {
    database.exec(`ALTER TABLE subscriptions ADD COLUMN premium_one_time_at INTEGER`);
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS model_pool_hidden (
      owner_user_id TEXT NOT NULL,
      hidden_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (owner_user_id, hidden_user_id),
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (hidden_user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_model_pool_hidden_owner ON model_pool_hidden(owner_user_id);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS premium_partners (
      user_id TEXT PRIMARY KEY,
      platform_share_percent INTEGER NOT NULL DEFAULT 40
        CHECK (platform_share_percent >= 0 AND platform_share_percent <= 100),
      hourly_rate_minor INTEGER,
      stripe_connect_account_id TEXT,
      connect_onboarding_complete INTEGER NOT NULL DEFAULT 0,
      payouts_enabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_premium_partners_connect ON premium_partners(stripe_connect_account_id);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      guest_user_id TEXT NOT NULL,
      model_user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled', 'in_progress', 'completed', 'expired')),
      currency TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3),
      total_amount_minor INTEGER NOT NULL CHECK (total_amount_minor >= 0),
      platform_fee_minor INTEGER NOT NULL DEFAULT 0 CHECK (platform_fee_minor >= 0),
      model_payout_minor INTEGER NOT NULL DEFAULT 0 CHECK (model_payout_minor >= 0),
      escrow_status TEXT NOT NULL DEFAULT 'not_funded'
        CHECK (escrow_status IN ('not_funded', 'funded', 'released', 'refunded', 'failed')),
      escrow_reference TEXT,
      scheduled_start_at INTEGER NOT NULL,
      scheduled_end_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      guest_note TEXT NOT NULL DEFAULT '',
      model_note TEXT NOT NULL DEFAULT '',
      cancel_reason TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (guest_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (model_user_id) REFERENCES users(id) ON DELETE CASCADE,
      CHECK (scheduled_end_at > scheduled_start_at),
      CHECK (guest_user_id != model_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_guest_user_id ON bookings(guest_user_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_model_user_id ON bookings(model_user_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
    CREATE INDEX IF NOT EXISTS idx_bookings_escrow_status ON bookings(escrow_status);
    CREATE INDEX IF NOT EXISTS idx_bookings_scheduled_start ON bookings(scheduled_start_at);
  `);

  const modelRows = database.prepare("SELECT id FROM users WHERE is_model = 1").all();
  const now = Date.now();
  const insPartner = database.prepare(
    `INSERT OR IGNORE INTO premium_partners (user_id, platform_share_percent, created_at, updated_at)
     VALUES (?, 40, ?, ?)`
  );
  for (const row of modelRows) {
    insPartner.run(row.id, now, now);
  }
}

function backfillModelPool(database) {
  const rows = database
    .prepare(
      `SELECT i.host_user_id, i.used_by_user_id, i.created_at, i.used_at
       FROM invites i
       INNER JOIN users ho ON ho.id = i.host_user_id
       INNER JOIN users gu ON gu.id = i.used_by_user_id
       WHERE i.used_by_user_id IS NOT NULL AND i.host_user_id IS NOT NULL`
    )
    .all();
  const ins = database.prepare(
    `INSERT OR IGNORE INTO model_pool (id, owner_user_id, model_user_id, created_at, registered_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const row of rows) {
    try {
      ins.run(
        randomUUID(),
        row.host_user_id,
        row.used_by_user_id,
        row.created_at,
        row.used_at || row.created_at
      );
    } catch (err) {
      if (err?.code !== "SQLITE_CONSTRAINT_FOREIGNKEY" && err?.code !== "SQLITE_CONSTRAINT_UNIQUE") {
        console.warn("[db] model_pool backfill row skipped:", err.message);
      }
    }
  }
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
