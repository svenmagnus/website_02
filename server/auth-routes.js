import "./load-env.js";
import { Router } from "express";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { getDb } from "./db.js";
import { encryptSecret } from "./smtp-crypto.js";
import { linkInviteHostToGuest } from "./social-routes.js";
import { avatarUrlForUser } from "./profile-avatar.js";
import { galleryForUserRow } from "./profile-gallery.js";
import { chatColorsFromRow, normalizeChatColorsInput } from "./chat-colors.js";
import { playModeSoundFromRow, normalizePlayModeSoundInput } from "./play-mode-sound.js";
import { isUserBanned, banFieldsForProfile, normalizeBanReasonInput } from "./member-ban.js";
import {
  getAppPublicUrl,
  hashInviteCode,
  isSmtpConfigured,
  isSmtpConfiguredForUser,
  resolveMailConfig,
  sendInviteEmail,
  sendRegistrationConfirmationEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendTestEmail,
  STRATO_MAIL_PRESET,
  verifySmtpConnection,
  getUserMailConfig,
  mapSmtpError,
  withMailTimeout,
  resolveSmtpSecure,
} from "./mail.js";
import {
  subscriptionFieldsForProfile,
  assertSubscriptionAccess,
  isStripeConfigured,
  normalizeSubscriptionOverride,
  resolveMembershipLabel,
  getSubscriptionRow,
  hasPremiumModelPoolAccess,
  applyBillingTestOverrideState,
} from "./billing.js";
import { normalizeAppearanceTheme } from "./mail-design.js";

const BCRYPT_ROUNDS = 12;
const SESSION_DAYS = 30;
const INVITE_DAYS = 7;
const VERIFY_HOURS = 48;
const RESET_HOURS = 24;
/** Host/dev bypass when no invite row (4 digits). Override: DEV_INVITE_CODE in .env */
const DEV_INVITE_CODE = String(process.env.DEV_INVITE_CODE || "1234").trim();
/** Skip verification emails — accounts are active immediately (dev/small deployments). */
const SKIP_EMAIL_VERIFY = /^(1|true|yes)$/i.test(String(process.env.SKIP_EMAIL_VERIFY || ""));
/** Return confirm link in API + server log when mail did not send (dev troubleshooting). */
const DEV_EXPOSE_VERIFY_URL = /^(1|true|yes)$/i.test(
  String(process.env.DEV_EXPOSE_VERIFY_URL || "")
);
const DEV_EXPOSE_RESET_URL = /^(1|true|yes)$/i.test(
  String(process.env.DEV_EXPOSE_RESET_URL || process.env.DEV_EXPOSE_VERIFY_URL || "")
);
/**
 * Dev-only instant login (skip bcrypt). Disable on public servers: DEV_LOGIN_FALLBACK=0 in .env
 * Optional overrides: DEV_LOGIN_USER, DEV_LOGIN_PASS
 */
const DEV_LOGIN_FALLBACK_ENABLED = String(process.env.DEV_LOGIN_FALLBACK ?? "1") !== "0";
const DEV_LOGIN_USERNAME = String(process.env.DEV_LOGIN_USER || "svenmagnus").trim();
const DEV_LOGIN_PASSWORD = String(process.env.DEV_LOGIN_PASS || "london12");
const ADMIN_USERNAMES = String(process.env.ADMIN_USERNAMES || "svenmagnus")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function isAdminUsername(username) {
  return ADMIN_USERNAMES.includes(String(username || "").trim().toLowerCase());
}

function isHostAccount(row) {
  return String(row?.account_type || "guest") === "host";
}

function isAdminAccount(row) {
  return Boolean(row?.is_admin);
}

function isPremiumAccount(row) {
  return Boolean(row?.is_premium);
}

function isFreeGuestAccount(row) {
  return Boolean(row?.is_free_guest);
}

function isModelAccount(row) {
  return Boolean(row?.is_model);
}

function isDevLoginFallback(username, password) {
  if (!DEV_LOGIN_FALLBACK_ENABLED) return false;
  return (
    String(username || "").toLowerCase() === DEV_LOGIN_USERNAME.toLowerCase() &&
    password === DEV_LOGIN_PASSWORD
  );
}

async function ensureDevLoginUser(db) {
  const at = nowMs();
  const passwordHash = await bcrypt.hash(DEV_LOGIN_PASSWORD, BCRYPT_ROUNDS);
  let user = db
    .prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE")
    .get(DEV_LOGIN_USERNAME);

  if (!user) {
    const userId = randomUUID();
    const email = `${DEV_LOGIN_USERNAME}@dev.local`;
    db.prepare(
      `INSERT INTO users (id, username, password_hash, email, email_verified_at, display_name, gender, bio, techniques_json, custom_techniques_json, lovense_toys, created_at, account_type, is_admin, is_premium)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userId,
      DEV_LOGIN_USERNAME,
      passwordHash,
      email,
      at,
      DEV_LOGIN_USERNAME,
      "",
      "",
      "[]",
      "[]",
      "",
      at,
      "host",
      1,
      1
    );
    user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    console.log(`[auth] Dev login: created user "${DEV_LOGIN_USERNAME}"`);
  } else {
    db.prepare(
      `UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), password_hash = ?, account_type = 'host', is_admin = 1, is_premium = 1 WHERE id = ?`
    ).run(at, passwordHash, user.id);
    user = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  }

  db.prepare("DELETE FROM email_verifications WHERE user_id = ?").run(user.id);
  return user;
}

function createSessionForUser(db, userId) {
  const sessionToken = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(
    sessionToken,
    userId,
    sessionExpiry()
  );
  return sessionToken;
}

function verificationLinkForUserId(userId) {
  const db = getDb();
  const row = db.prepare("SELECT token FROM email_verifications WHERE user_id = ?").get(userId);
  if (!row?.token) return null;
  return `${getAppPublicUrl()}/verify-email.html?token=${encodeURIComponent(row.token)}`;
}

export const authRouter = Router();

function nowMs() {
  return Date.now();
}

function sessionExpiry() {
  return nowMs() + SESSION_DAYS * 24 * 60 * 60 * 1000;
}

function inviteExpiry() {
  return nowMs() + INVITE_DAYS * 24 * 60 * 60 * 1000;
}

function verifyExpiry() {
  return nowMs() + VERIFY_HOURS * 60 * 60 * 1000;
}

function resetExpiry() {
  return nowMs() + RESET_HOURS * 60 * 60 * 1000;
}

const PASSWORD_RESET_GENERIC_MESSAGE =
  "If an account exists for that email or username, we sent password reset instructions.";

function findUserForPasswordReset({ email, username }) {
  const db = getDb();
  const byUsername = username
    ? db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username)
    : null;
  if (byUsername) return byUsername;
  const byEmail = email
    ? db.prepare("SELECT * FROM users WHERE LOWER(email) = LOWER(?)").get(email)
    : null;
  return byEmail || null;
}

async function createPasswordResetToken(userId) {
  const db = getDb();
  const token = randomBytes(32).toString("hex");
  const createdAt = nowMs();
  const expiresAt = resetExpiry();
  db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(userId);
  db.prepare(
    "INSERT INTO password_reset_tokens (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).run(token, userId, expiresAt, createdAt);
  return token;
}

async function sendUserPasswordResetEmail(user) {
  const token = await createPasswordResetToken(user.id);
  const resetUrl = `${getAppPublicUrl()}/reset-password.html?token=${encodeURIComponent(token)}`;
  const mailResult = await sendPasswordResetEmail({
    to: user.email,
    resetUrl,
    username: user.username,
    userRow: user,
  });
  return { resetUrl, mailResult };
}

function clearPasswordResetForUser(userId) {
  const db = getDb();
  db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(userId);
}

function revokeAllSessionsForUser(userId) {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

function parseBearer(req) {
  const raw = String(req.get("authorization") || "").trim();
  if (!/^Bearer\s+/i.test(raw)) return null;
  return raw.replace(/^Bearer\s+/i, "").trim();
}

function generateInviteCode() {
  return String(randomInt(1000, 10000));
}

function generateUniqueInviteCode(db) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const code = generateInviteCode();
    const codeHash = hashInviteCode(code);
    const clash = db
      .prepare(
        `SELECT 1 FROM invites WHERE invite_code_hash = ? AND used_at IS NULL AND expires_at > ? LIMIT 1`
      )
      .get(codeHash, nowMs());
    if (!clash) return code;
  }
  return generateInviteCode();
}

function isManualInviteEmail(email) {
  return !String(email || "").trim();
}

function findActiveInviteByCodeOnly(code) {
  const normalizedCode = String(code || "").trim();
  if (!/^\d{4}$/.test(normalizedCode)) return null;
  const codeHash = hashInviteCode(normalizedCode);
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC`)
    .all(nowMs());
  return rows.find((row) => row.invite_code_hash === codeHash) || null;
}

function isDevInviteCode(code) {
  const c = String(code || "").trim();
  return DEV_INVITE_CODE.length === 4 && c === DEV_INVITE_CODE;
}

function rowToProfile(row) {
  let techniques = [];
  let customTechniques = [];
  try {
    techniques = JSON.parse(row.techniques_json || "[]");
  } catch (_) {
    /* ignore */
  }
  try {
    customTechniques = JSON.parse(row.custom_techniques_json || "[]");
  } catch (_) {
    /* ignore */
  }
  let playPrefs = { dynamics: [], kinks: [], intensity: [] };
  try {
    const parsed = JSON.parse(row.play_prefs_json || "{}");
    if (parsed && typeof parsed === "object") playPrefs = parsed;
  } catch (_) {
    /* ignore */
  }
  let customMenus = [];
  let enabledCustomMenus = [];
  try {
    const parsed = JSON.parse(row.custom_menus_json || "{}");
    if (Array.isArray(parsed?.menus)) customMenus = parsed.menus;
    if (Array.isArray(parsed?.enabled)) enabledCustomMenus = parsed.enabled;
  } catch (_) {
    /* ignore */
  }
  return {
    id: row.id,
    username: row.username,
    email: row.email || "",
    emailVerified: Boolean(row.email_verified_at),
    displayName: row.display_name,
    gender: row.gender || "",
    bio: row.bio || "",
    techniques: Array.isArray(techniques) ? techniques : [],
    customTechniques: Array.isArray(customTechniques) ? customTechniques : [],
    customMenus: Array.isArray(customMenus) ? customMenus : [],
    enabledCustomMenus: Array.isArray(enabledCustomMenus) ? enabledCustomMenus : [],
    playPrefs: {
      dynamics: Array.isArray(playPrefs.dynamics) ? playPrefs.dynamics : [],
      kinks: Array.isArray(playPrefs.kinks) ? playPrefs.kinks : [],
      intensity: Array.isArray(playPrefs.intensity) ? playPrefs.intensity : [],
    },
    lovenseToys: String(row.lovense_toys || "").slice(0, 500),
    nationality: String(row.nationality || "").slice(0, 64),
    languages: String(row.languages || "").slice(0, 120),
    location: String(row.location || "").slice(0, 120),
    age: row.age != null && Number.isInteger(row.age) ? row.age : null,
    bodyType: String(row.body_type || "").slice(0, 48),
    interestedIn: String(row.interested_in || "").slice(0, 120),
    galleryImages: galleryForUserRow(row),
    createdAt: row.created_at,
    mailConfigured: isSmtpConfiguredForUser(row),
    accountType: isHostAccount(row) ? "host" : "guest",
    isAdmin: isAdminAccount(row),
    isPremium: isPremiumAccount(row),
    isModel: isModelAccount(row),
    avatarUrl: avatarUrlForUser(row),
    chatColors: chatColorsFromRow(row),
    playModeSound: playModeSoundFromRow(row),
    appearanceTheme: normalizeAppearanceTheme(row.appearance_theme || "neon"),
    ...banFieldsForProfile(row),
    ...subscriptionFieldsForProfile(row),
  };
}

function rowToMailSettings(row) {
  return {
    configured: isSmtpConfiguredForUser(row),
    hasPassword: Boolean(row.smtp_out_pass_enc),
    outgoing: {
      host: row.smtp_out_host || "",
      port: Number(row.smtp_out_port) || 587,
      secure: Boolean(row.smtp_out_secure) || Number(row.smtp_out_port) === 465,
      user: row.smtp_out_user || "",
      from: row.smtp_from || row.smtp_out_user || "",
    },
    incoming: {
      host: row.imap_in_host || "",
      port: Number(row.imap_in_port) || 993,
      secure: row.imap_in_secure == null ? true : Boolean(row.imap_in_secure),
      user: row.imap_in_user || "",
    },
  };
}

const PLACEHOLDER_MAIL_PASSWORDS = new Set([
  "strato-postfach-passwort",
  "strato postfach-passwort",
  "••••••••",
  "********",
]);

function isPlaceholderMailboxPassword(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return true;
  return PLACEHOLDER_MAIL_PASSWORDS.has(v);
}

function parseMailSettingsBody(body) {
  const out = body?.outgoing || {};
  const inc = body?.incoming || {};
  const host = String(out.host || "").trim().slice(0, 255);
  const port = Number(out.port) || 587;
  const user = String(out.user || "").trim().slice(0, 255);
  const from = String(out.from || out.user || "").trim().slice(0, 255);
  const secure = resolveSmtpSecure(port, out.secure);
  let password = body?.password != null ? String(body.password).trim() : null;
  if (password && isPlaceholderMailboxPassword(password)) password = "";

  const imapHost = String(inc.host || "").trim().slice(0, 255);
  const imapPort = Number(inc.port) || 993;
  const imapUser = String(inc.user || "").trim().slice(0, 255);
  const imapSecure = inc.secure !== false;

  if (!host || !user) {
    return { error: "invalid_mail_settings" };
  }
  if (password === "") password = null;
  if (password !== null && password.length > 0 && password.length < 4) {
    return { error: "invalid_mail_password" };
  }

  return {
    smtp_out_host: host,
    smtp_out_port: port,
    smtp_out_secure: secure ? 1 : 0,
    smtp_out_user: user,
    smtp_from: from || user,
    imap_in_host: imapHost,
    imap_in_port: imapPort,
    imap_in_secure: imapSecure ? 1 : 0,
    imap_in_user: imapUser || user,
    password,
  };
}

function getUserByToken(token) {
  if (!token) return null;
  const db = getDb();
  const session = db
    .prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?")
    .get(token);
  if (!session || session.expires_at < nowMs()) {
    if (session) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  return db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id) || null;
}

function requireAuth(req, res, next) {
  const token = parseBearer(req);
  const user = getUserByToken(token);
  if (!user) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  if (isUserBanned(user)) {
    const isLogout = req.method === "POST" && String(req.path || "").endsWith("/auth/logout");
    if (!isLogout) {
      return res.status(403).json({
        ok: false,
        error: "account_banned",
        message: "Your account has been banned.",
        banReason: String(user.ban_reason || "").trim(),
        bannedAt: user.banned_at || null,
      });
    }
  }
  req.authUser = user;
  req.authToken = token;
  next();
}

function requireHostAccount(req, res, next) {
  if (!isHostAccount(req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "host_account_required",
      message: "Inviting guests requires a host account.",
    });
  }
  next();
}

function requireAdminAccount(req, res, next) {
  if (!isAdminAccount(req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "admin_required",
      message: "Email server settings are restricted to administrators.",
    });
  }
  next();
}

function normalizeAccountType(value) {
  const t = String(value || "").trim().toLowerCase();
  return t === "host" ? "host" : "guest";
}

function normalizeCurrency(value) {
  const c = String(value || "EUR").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) return null;
  return c;
}

function normalizeAmountMinor(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function validateUsername(username) {
  const u = String(username || "").trim();
  if (u.length < 3 || u.length > 24) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(u)) return null;
  return u;
}

function validatePassword(password) {
  const p = String(password || "");
  if (p.length < 8 || p.length > 128) return null;
  return p;
}

function validateEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

function validateGuestName(name) {
  const n = String(name || "").trim().slice(0, 64);
  if (!n) return null;
  return n;
}

function findActiveInviteByToken(token) {
  if (!token) return null;
  const db = getDb();
  const invite = db.prepare("SELECT * FROM invites WHERE token = ?").get(token);
  if (!invite || invite.used_at || invite.expires_at < nowMs()) return null;
  return invite;
}

function findActiveInviteByEmailAndCode(email, code) {
  const normalizedEmail = validateEmail(email);
  const normalizedCode = String(code || "").trim();
  if (!normalizedEmail || !/^\d{4}$/.test(normalizedCode)) return null;

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM invites WHERE email = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC`
    )
    .all(normalizedEmail, nowMs());

  const codeHash = hashInviteCode(normalizedCode);
  return rows.find((row) => row.invite_code_hash === codeHash) || null;
}

function resolveInvite({ inviteToken, inviteCode, email }) {
  if (inviteToken) {
    const byToken = findActiveInviteByToken(inviteToken);
    if (byToken) return byToken;
  }
  const normalizedCode = String(inviteCode || "").trim();
  if (!/^\d{4}$/.test(normalizedCode)) return null;

  const byEmailCode = findActiveInviteByEmailAndCode(email, normalizedCode);
  if (byEmailCode) return byEmailCode;

  const byCode = findActiveInviteByCodeOnly(normalizedCode);
  if (byCode) return byCode;

  return null;
}

async function createVerificationToken(userId) {
  const db = getDb();
  const token = randomBytes(32).toString("hex");
  const createdAt = nowMs();
  const expiresAt = verifyExpiry();

  db.prepare("DELETE FROM email_verifications WHERE user_id = ?").run(userId);
  db.prepare(
    "INSERT INTO email_verifications (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).run(token, userId, expiresAt, createdAt);

  return token;
}

async function sendUserVerificationEmail(user, { mailUserRow } = {}) {
  const verifyToken = await createVerificationToken(user.id);
  const verifyUrl = `${getAppPublicUrl()}/verify-email.html?token=${encodeURIComponent(verifyToken)}`;
  const senderRow = mailUserRow || user;
  const mailResult = await sendVerificationEmail({
    to: user.email,
    verifyUrl,
    username: user.username,
    userRow: senderRow,
  });
  return { verifyUrl, mailResult };
}

function markEmailVerified(userId) {
  const db = getDb();
  const at = nowMs();
  db.prepare("UPDATE users SET email_verified_at = ? WHERE id = ?").run(at, userId);
  db.prepare("DELETE FROM email_verifications WHERE user_id = ?").run(userId);
  return at;
}

authRouter.get("/auth/invite/:token", (req, res) => {
  const invite = findActiveInviteByToken(req.params.token);
  if (!invite) {
    return res.status(404).json({ ok: false, error: "invite_not_found" });
  }
  const db = getDb();
  const host = db.prepare("SELECT display_name, username FROM users WHERE id = ?").get(invite.host_user_id);
  res.json({
    ok: true,
    email: invite.email || null,
    manualInvite: isManualInviteEmail(invite.email),
    expiresAt: invite.expires_at,
    hostName: host?.display_name || host?.username || "Host",
  });
});

authRouter.post("/auth/forgot-password", async (req, res) => {
  const email = validateEmail(req.body?.email);
  const username = validateUsername(req.body?.username);
  if (!email && !username) {
    return res.status(400).json({ ok: false, error: "identifier_required" });
  }

  try {
    const user = findUserForPasswordReset({ email, username });
    let devResetUrl;
    if (user && user.email && !isUserBanned(user)) {
      const { resetUrl, mailResult } = await sendUserPasswordResetEmail(user);
      if (!mailResult.sent && (DEV_EXPOSE_RESET_URL || mailResult.devMode)) {
        devResetUrl = resetUrl;
        console.log(`[auth] Password reset link for ${user.username}:\n  ${resetUrl}`);
      }
    }
    res.json({
      ok: true,
      message: PASSWORD_RESET_GENERIC_MESSAGE,
      devResetUrl,
    });
  } catch (err) {
    console.error("[auth] forgot-password failed:", err);
    res.json({
      ok: true,
      message: PASSWORD_RESET_GENERIC_MESSAGE,
    });
  }
});

authRouter.get("/auth/reset-password/:token", (req, res) => {
  const { token } = req.params;
  const db = getDb();
  const row = db.prepare("SELECT * FROM password_reset_tokens WHERE token = ?").get(token);
  if (!row) {
    return res.status(404).json({ ok: false, error: "reset_not_found" });
  }
  if (row.expires_at < nowMs()) {
    db.prepare("DELETE FROM password_reset_tokens WHERE token = ?").run(token);
    return res.status(410).json({ ok: false, error: "reset_expired" });
  }
  const user = db.prepare("SELECT username FROM users WHERE id = ?").get(row.user_id);
  res.json({
    ok: true,
    username: user?.username || null,
    expiresAt: row.expires_at,
  });
});

authRouter.post("/auth/reset-password", async (req, res) => {
  const token = String(req.body?.token || "").trim();
  const password = validatePassword(req.body?.password);
  if (!token) {
    return res.status(400).json({ ok: false, error: "reset_token_required" });
  }
  if (!password) {
    return res.status(400).json({ ok: false, error: "invalid_password" });
  }

  const db = getDb();
  const row = db.prepare("SELECT * FROM password_reset_tokens WHERE token = ?").get(token);
  if (!row) {
    return res.status(404).json({ ok: false, error: "reset_not_found" });
  }
  if (row.expires_at < nowMs()) {
    db.prepare("DELETE FROM password_reset_tokens WHERE token = ?").run(token);
    return res.status(410).json({ ok: false, error: "reset_expired" });
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(row.user_id);
  if (!user) {
    db.prepare("DELETE FROM password_reset_tokens WHERE token = ?").run(token);
    return res.status(404).json({ ok: false, error: "reset_not_found" });
  }
  if (isUserBanned(user)) {
    return res.status(403).json({ ok: false, error: "account_banned" });
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, user.id);
  clearPasswordResetForUser(user.id);
  revokeAllSessionsForUser(user.id);
  db.prepare("DELETE FROM email_verifications WHERE user_id = ?").run(user.id);

  res.json({
    ok: true,
    message: "Password updated. You can sign in with your new password.",
    username: user.username,
  });
});

authRouter.get("/auth/verify-email/:token", async (req, res) => {
  const { token } = req.params;
  const db = getDb();
  const row = db.prepare("SELECT * FROM email_verifications WHERE token = ?").get(token);
  if (!row) {
    return res.status(404).json({ ok: false, error: "verify_not_found" });
  }
  if (row.expires_at < nowMs()) {
    db.prepare("DELETE FROM email_verifications WHERE token = ?").run(token);
    return res.status(410).json({ ok: false, error: "verify_expired" });
  }

  markEmailVerified(row.user_id);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(row.user_id);
  res.json({
    ok: true,
    username: user?.username,
    message: "E-Mail bestätigt. Du kannst dich jetzt anmelden.",
  });
});

authRouter.post("/auth/resend-verification", async (req, res) => {
  const username = validateUsername(req.body?.username);
  const password = validatePassword(req.body?.password);
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: "invalid_credentials" });
  }

  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ ok: false, error: "invalid_credentials" });
  }
  if (user.email_verified_at) {
    return res.json({ ok: true, alreadyVerified: true, message: "E-Mail ist bereits bestätigt." });
  }
  if (!user.email) {
    return res.status(400).json({ ok: false, error: "no_email" });
  }

  try {
    const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
    const { verifyUrl, mailResult } = await sendUserVerificationEmail(fresh);
    res.json({
      ok: true,
      emailSent: mailResult.sent,
      devVerifyUrl: mailResult.devMode ? verifyUrl : undefined,
      message: mailResult.sent
        ? "Bestätigungs-E-Mail wurde erneut gesendet."
        : "Kein E-Mail-Versand konfiguriert — Link in der Server-Konsole oder SMTP im Profil.",
    });
  } catch (err) {
    console.error("[mail] resend verification failed:", err);
    return res.status(500).json({ ok: false, error: "email_failed", message: err.message });
  }
});

authRouter.post("/auth/register", async (req, res) => {
  const inviteToken = String(req.body?.inviteToken || "").trim();
  const inviteCode = String(req.body?.inviteCode || "").trim();
  const email = validateEmail(req.body?.email);
  const username = validateUsername(req.body?.username);
  const password = validatePassword(req.body?.password);
  const displayName = String(username || "Guest").trim().slice(0, 32) || "Guest";
  const gender = "";
  const bio = "";
  const techniques = [];
  const customTechniques = [];

  if (!email) {
    return res.status(400).json({ ok: false, error: "invalid_email" });
  }
  if (!username) {
    return res.status(400).json({ ok: false, error: "invalid_username" });
  }
  if (!password) {
    return res.status(400).json({ ok: false, error: "invalid_password" });
  }

  const db = getDb();
  const userCount = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  const devBypass = isDevInviteCode(inviteCode);
  let invite = devBypass ? null : resolveInvite({ inviteToken, inviteCode, email });

  if (!invite && !devBypass && userCount > 0) {
    return res.status(400).json({ ok: false, error: "invite_required" });
  }

  const existingUser = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(username);
  if (existingUser) {
    return res.status(409).json({ ok: false, error: "username_taken" });
  }

  const existingEmail = db.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE").get(email);
  if (existingEmail) {
    return res.status(409).json({ ok: false, error: "email_taken" });
  }

  const userId = randomUUID();
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const createdAt = nowMs();
  const accountType = invite ? "guest" : "host";
  const isAdmin = isAdminUsername(username) ? 1 : 0;
  const isPremium = isAdmin ? 1 : 0;

  db.prepare(
    `INSERT INTO users (id, username, password_hash, email, email_verified_at, display_name, gender, bio, techniques_json, custom_techniques_json, created_at, account_type, is_admin, is_premium)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    username,
    passwordHash,
    email,
    null,
    displayName,
    gender,
    bio,
    JSON.stringify(techniques),
    JSON.stringify(customTechniques),
    createdAt,
    accountType,
    isAdmin,
    isPremium
  );

  if (invite) {
    db.prepare("UPDATE invites SET used_at = ?, used_by_user_id = ? WHERE token = ?").run(
      createdAt,
      userId,
      invite.token
    );
    const guestName =
      String(invite.guest_name || "").trim() || displayName || username;
    try {
      linkInviteHostToGuest(db, invite.host_user_id, userId, guestName);
    } catch (err) {
      console.error("[social] link invite host/guest failed:", err);
    }
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  let emailSent = false;
  let devVerifyUrl = null;
  const loginUrl = `${getAppPublicUrl()}/index.html`;

  let mailSenderRow = user;
  if (invite) {
    mailSenderRow =
      db.prepare("SELECT * FROM users WHERE id = ?").get(invite.host_user_id) || user;
  }

  const mailConfig = resolveMailConfig(mailSenderRow);
  let verifyUrl = null;

  if (SKIP_EMAIL_VERIFY) {
    markEmailVerified(userId);
    console.log(`[auth] SKIP_EMAIL_VERIFY — ${email} auto-verified`);
  } else if (!mailConfig) {
    markEmailVerified(userId);
    console.log(`[auth] No SMTP — ${email} auto-verified (dev / no mail config)`);
  } else {
    const verifyToken = await createVerificationToken(userId);
    verifyUrl = `${getAppPublicUrl()}/verify-email.html?token=${encodeURIComponent(verifyToken)}`;
  }

  if (mailConfig) {
    try {
      const verifiedNow = Boolean(
        db.prepare("SELECT email_verified_at FROM users WHERE id = ?").get(userId).email_verified_at
      );
      const mailResult = await sendRegistrationConfirmationEmail({
        to: email,
        username,
        email,
        password,
        loginUrl,
        verifyUrl: verifiedNow ? null : verifyUrl,
        userRow: mailSenderRow,
      });
      emailSent = mailResult.sent;
      if (DEV_EXPOSE_VERIFY_URL || mailResult.devMode) {
        devVerifyUrl = verifyUrl || undefined;
      }
      if (!emailSent && verifyUrl) {
        devVerifyUrl = devVerifyUrl || verifyUrl;
        console.log(
          `[mail] Registration confirmation for ${email} (not sent — check SMTP):\n` +
            `  Login: ${loginUrl}\n` +
            (verifyUrl ? `  Verify: ${verifyUrl}\n` : "")
        );
      }
    } catch (err) {
      console.error("[mail] registration confirmation send failed:", err);
      db.prepare("DELETE FROM users WHERE id = ?").run(userId);
      return res.status(500).json({ ok: false, error: "email_failed", message: err.message });
    }
  }

  const verifiedUser = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  let token = null;
  if (verifiedUser.email_verified_at) {
    token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(
      token,
      userId,
      sessionExpiry()
    );
  }

  if (!verifiedUser.email_verified_at && DEV_EXPOSE_VERIFY_URL && !devVerifyUrl) {
    devVerifyUrl = verificationLinkForUserId(userId);
  }

  res.status(201).json({
    ok: true,
    needsEmailVerification: !verifiedUser.email_verified_at,
    emailSent,
    email,
    username,
    token: token || undefined,
    user: token ? rowToProfile(verifiedUser) : undefined,
    devVerifyUrl: devVerifyUrl || undefined,
    message: verifiedUser.email_verified_at
      ? emailSent
        ? "Account created. A confirmation email with your login details was sent."
        : "Account created — set up your profile next."
      : emailSent
        ? "Account created. A confirmation email with your login details and email confirmation link was sent (check spam too)."
        : "Account created. Email delivery not active — see confirmation link below or server console.",
  });
});

authRouter.post("/auth/login", async (req, res) => {
  const username = validateUsername(req.body?.username);
  const password = String(req.body?.password || "");
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: "invalid_credentials" });
  }

  const db = getDb();

  if (isDevLoginFallback(username, password)) {
    try {
      const user = await ensureDevLoginUser(db);
      const sessionToken = createSessionForUser(db, user.id);
      return res.json({
        ok: true,
        token: sessionToken,
        user: rowToProfile(user),
      });
    } catch (err) {
      console.error("[auth] Dev login fallback failed:", err);
      return res.status(500).json({ ok: false, error: "login_failed", message: err.message });
    }
  }

  const user = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username);
  if (!user) {
    return res.status(401).json({ ok: false, error: "invalid_credentials" });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return res.status(401).json({ ok: false, error: "invalid_credentials" });
  }

  if (!user.email_verified_at) {
    return res.status(403).json({
      ok: false,
      error: "email_not_verified",
      email: user.email,
      message: "Bitte bestätige zuerst deine E-Mail-Adresse.",
    });
  }

  if (isUserBanned(user)) {
    return res.status(403).json({
      ok: false,
      error: "account_banned",
      message: "Your account has been banned.",
      banReason: String(user.ban_reason || "").trim(),
      bannedAt: user.banned_at || null,
    });
  }

  const sessionToken = createSessionForUser(db, user.id);

  res.json({
    ok: true,
    token: sessionToken,
    user: rowToProfile(user),
  });
});

authRouter.post("/auth/logout", requireAuth, (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE token = ?").run(req.authToken);
  db.prepare("UPDATE users SET last_seen_at = NULL WHERE id = ?").run(req.authUser.id);
  res.json({ ok: true });
});

authRouter.get("/auth/me", requireAuth, (req, res) => {
  res.json({ ok: true, user: rowToProfile(req.authUser) });
});

authRouter.get("/profile", requireAuth, (req, res) => {
  res.json({ ok: true, profile: rowToProfile(req.authUser) });
});

authRouter.patch("/profile", requireAuth, (req, res) => {
  const db = getDb();
  const current = rowToProfile(req.authUser);
  const displayName = req.body?.displayName != null
    ? String(req.body.displayName).trim().slice(0, 32) || current.username
    : current.displayName;
  const gender = req.body?.gender != null ? String(req.body.gender).slice(0, 32) : current.gender;
  const bio = req.body?.bio != null ? String(req.body.bio).trim().slice(0, 500) : current.bio;
  const techniques = req.body?.techniques != null ? req.body.techniques : current.techniques;
  const customTechniques =
    req.body?.customTechniques != null ? req.body.customTechniques : current.customTechniques;
  const lovenseToys =
    req.body?.lovenseToys != null
      ? String(req.body.lovenseToys).trim().slice(0, 500)
      : current.lovenseToys;
  const nationality =
    req.body?.nationality != null
      ? String(req.body.nationality).trim().slice(0, 64)
      : current.nationality;
  const languages =
    req.body?.languages != null
      ? String(req.body.languages).trim().slice(0, 120)
      : current.languages;
  const location =
    req.body?.location != null ? String(req.body.location).trim().slice(0, 120) : current.location;
  const age =
    req.body?.age != null
      ? (() => {
          if (req.body.age === "" || req.body.age == null) return null;
          const n = Number(req.body.age);
          if (!Number.isInteger(n) || n < 18 || n > 120) return current.age;
          return n;
        })()
      : current.age;
  const bodyType =
    req.body?.bodyType != null
      ? String(req.body.bodyType).trim().slice(0, 48)
      : current.bodyType;
  const interestedIn =
    req.body?.interestedIn != null
      ? String(req.body.interestedIn).trim().slice(0, 120)
      : current.interestedIn;
  const playPrefs =
    req.body?.playPrefs != null
      ? {
          dynamics: Array.isArray(req.body.playPrefs.dynamics) ? req.body.playPrefs.dynamics : [],
          kinks: Array.isArray(req.body.playPrefs.kinks) ? req.body.playPrefs.kinks : [],
          intensity: Array.isArray(req.body.playPrefs.intensity) ? req.body.playPrefs.intensity : [],
        }
      : current.playPrefs;
  const customMenus =
    req.body?.customMenus != null ? req.body.customMenus : current.customMenus;
  const enabledCustomMenus =
    req.body?.enabledCustomMenus != null
      ? req.body.enabledCustomMenus
      : current.enabledCustomMenus;
  const chatColors =
    req.body?.chatColors != null ? normalizeChatColorsInput(req.body.chatColors) : current.chatColors;
  const playModeSound =
    req.body?.playModeSound != null
      ? normalizePlayModeSoundInput(req.body.playModeSound)
      : current.playModeSound;
  const appearanceTheme =
    req.body?.appearanceTheme != null
      ? normalizeAppearanceTheme(req.body.appearanceTheme)
      : current.appearanceTheme;

  db.prepare(
    `UPDATE users SET display_name = ?, gender = ?, bio = ?, techniques_json = ?, custom_techniques_json = ?, custom_menus_json = ?, play_prefs_json = ?, lovense_toys = ?, nationality = ?, languages = ?, location = ?, age = ?, body_type = ?, interested_in = ?, chat_colors_json = ?, play_mode_sound = ?, appearance_theme = ?
     WHERE id = ?`
  ).run(
    displayName,
    gender,
    bio,
    JSON.stringify(Array.isArray(techniques) ? techniques : []),
    JSON.stringify(Array.isArray(customTechniques) ? customTechniques : []),
    JSON.stringify({
      menus: Array.isArray(customMenus) ? customMenus : [],
      enabled: Array.isArray(enabledCustomMenus) ? enabledCustomMenus : [],
    }),
    JSON.stringify(playPrefs),
    lovenseToys,
    nationality,
    languages,
    location,
    age,
    bodyType,
    interestedIn,
    chatColors ? JSON.stringify(chatColors) : null,
    playModeSound,
    appearanceTheme,
    req.authUser.id
  );

  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(req.authUser.id);
  res.json({ ok: true, profile: rowToProfile(updated) });
});

authRouter.get("/profile/mail", requireAuth, requireAdminAccount, (req, res) => {
  res.json({
    ok: true,
    mail: rowToMailSettings(req.authUser),
    serverFallbackConfigured: isSmtpConfigured(),
    preset: STRATO_MAIL_PRESET,
  });
});

authRouter.patch("/profile/mail", requireAuth, requireAdminAccount, (req, res) => {
  const parsed = parseMailSettingsBody(req.body);
  if (parsed.error) {
    return res.status(400).json({ ok: false, error: parsed.error });
  }

  const db = getDb();
  const current = req.authUser;
  let passEnc = current.smtp_out_pass_enc;
  if (parsed.password && parsed.password.length > 0) {
    passEnc = encryptSecret(parsed.password);
  } else if (!passEnc) {
    return res.status(400).json({
      ok: false,
      error: "mail_password_required",
      message: "Mailbox password is required.",
    });
  }

  db.prepare(
    `UPDATE users SET
      smtp_out_host = ?, smtp_out_port = ?, smtp_out_secure = ?,
      smtp_out_user = ?, smtp_out_pass_enc = ?, smtp_from = ?,
      imap_in_host = ?, imap_in_port = ?, imap_in_secure = ?, imap_in_user = ?
     WHERE id = ?`
  ).run(
    parsed.smtp_out_host,
    parsed.smtp_out_port,
    parsed.smtp_out_secure,
    parsed.smtp_out_user,
    passEnc,
    parsed.smtp_from,
    parsed.imap_in_host,
    parsed.imap_in_port,
    parsed.imap_in_secure,
    parsed.imap_in_user,
    req.authUser.id
  );

  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(req.authUser.id);
  res.json({ ok: true, mail: rowToMailSettings(updated) });
});

authRouter.post("/profile/mail/test", requireAuth, requireAdminAccount, async (req, res) => {
  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.authUser.id);
  const config = getUserMailConfig(user);
  if (!config) {
    return res.status(400).json({
      ok: false,
      error: "mail_not_configured",
      message: "Save outgoing SMTP settings in Email server (SMTP) first.",
    });
  }

  const to = validateEmail(req.body?.to) || validateEmail(user.email);
  if (!to) {
    return res.status(400).json({ ok: false, error: "invalid_email" });
  }

  try {
    await withMailTimeout(verifySmtpConnection(config));
    await withMailTimeout(sendTestEmail({ to, username: user.username, userRow: user }));
    res.json({
      ok: true,
      message: `Test email sent to ${to}.`,
    });
  } catch (err) {
    console.error("[mail] test failed:", err);
    const mapped = mapSmtpError(err);
    return res.status(mapped.status).json({
      ok: false,
      error: mapped.error,
      message: mapped.message,
    });
  }
});

authRouter.post("/invites", requireAuth, async (req, res) => {
  try {
    assertSubscriptionAccess(req.authUser);
  } catch (err) {
    if (err.code === "subscription_required") {
      return res.status(402).json({ ok: false, error: err.code, subscription: err.subscription });
    }
    throw err;
  }
  const emailRaw = String(req.body?.email || "").trim();
  const email = emailRaw ? validateEmail(emailRaw) : null;
  if (emailRaw && !email) {
    return res.status(400).json({ ok: false, error: "invalid_email" });
  }
  const guestName = validateGuestName(req.body?.guestName);
  if (!guestName) {
    return res.status(400).json({ ok: false, error: "invalid_guest_name" });
  }

  const inviteToken = randomBytes(24).toString("base64url");
  const db = getDb();
  const inviteCode = generateUniqueInviteCode(db);
  const inviteCodeHash = hashInviteCode(inviteCode);
  const createdAt = nowMs();
  const expiresAt = inviteExpiry();
  const storedEmail = email || "";

  // Any logged-in user can invite; inviting makes/keeps the account a host.
  db.prepare("UPDATE users SET account_type = 'host' WHERE id = ?").run(req.authUser.id);

  db.prepare(
    `INSERT INTO invites (token, email, host_user_id, invite_code_hash, guest_name, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(inviteToken, storedEmail, req.authUser.id, inviteCodeHash, guestName, createdAt, expiresAt);

  const inviteUrl = `${getAppPublicUrl()}/register.html?token=${encodeURIComponent(inviteToken)}`;
  const hostName = req.authUser.display_name || req.authUser.username;

  const hostRow = db.prepare("SELECT * FROM users WHERE id = ?").get(req.authUser.id);
  const appearanceTheme = normalizeAppearanceTheme(
    req.body?.appearanceTheme || hostRow?.appearance_theme || "neon"
  );
  if (req.body?.appearanceTheme != null) {
    db.prepare("UPDATE users SET appearance_theme = ? WHERE id = ?").run(
      appearanceTheme,
      req.authUser.id
    );
  }

  let mailResult = { sent: false, devMode: !email };
  if (email) {
    try {
      mailResult = await withMailTimeout(
        sendInviteEmail({
          to: email,
          inviteUrl,
          hostName,
          inviteCode,
          guestName,
          userRow: hostRow,
          appearanceTheme,
        })
      );
    } catch (err) {
      console.error("[mail] send failed:", err);
      const mapped = mapSmtpError(err);
      return res.status(mapped.status).json({
        ok: false,
        error: mapped.error,
        message: mapped.message,
      });
    }
  }

  res.status(201).json({
    ok: true,
    email: email || null,
    inviteUrl,
    inviteCode,
    manualShare: !email,
    emailSent: Boolean(email && mailResult.sent),
    platformEmailConfigured: isSmtpConfigured(),
    smtpConfigured: isSmtpConfiguredForUser(hostRow),
    mailSource: mailResult.source || null,
    expiresAt,
  });
});

authRouter.get("/models/premium", requireAuth, (req, res) => {
  if (!hasPremiumModelPoolAccess(req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "premium_required",
      message: "Premium membership is required to browse Premium Partners.",
    });
  }
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, username, display_name, account_type, is_premium, is_admin, is_model, avatar_path, avatar_updated_at, last_seen_at
       FROM users
       WHERE is_model = 1 AND id != ?
       ORDER BY created_at ASC`
    )
    .all(req.authUser.id);

  const models = rows.map((row) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    accountType: normalizeAccountType(row.account_type),
    isPremium: Boolean(row.is_premium),
    isAdmin: Boolean(row.is_admin),
    isModel: Boolean(row.is_model),
    avatarUrl: avatarUrlForUser(row),
    online: Boolean(row.last_seen_at && row.last_seen_at > Date.now() - 90_000),
    signedIn: Boolean(row.last_seen_at && row.last_seen_at > Date.now() - 90_000),
    availabilityText: "Availability calendar coming soon",
  }));

  return res.json({ ok: true, models });
});

authRouter.post("/book-model", requireAuth, (req, res) => {
  try {
    assertSubscriptionAccess(req.authUser);
  } catch (err) {
    if (err.code === "subscription_required") {
      return res.status(402).json({ ok: false, error: err.code, subscription: err.subscription });
    }
    throw err;
  }
  if (!hasPremiumModelPoolAccess(req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "premium_required",
      message: "Premium membership is required to book Premium Partners.",
    });
  }
  const db = getDb();
  const guestUserId = req.authUser.id;
  const modelUserId = String(req.body?.modelUserId || "").trim();
  const scheduledStartAt = Number(req.body?.scheduledStartAt);
  const scheduledEndAt = Number(req.body?.scheduledEndAt);
  const currency = normalizeCurrency(req.body?.currency || "EUR");
  const totalAmountMinor = normalizeAmountMinor(req.body?.totalAmountMinor, 0);
  const platformFeeMinor = normalizeAmountMinor(req.body?.platformFeeMinor, 0);
  const modelPayoutMinor = normalizeAmountMinor(req.body?.modelPayoutMinor, 0);
  const guestNote = String(req.body?.guestNote || "").trim().slice(0, 1000);

  if (!modelUserId) {
    return res.status(400).json({ ok: false, error: "invalid_model_user" });
  }
  if (modelUserId === guestUserId) {
    return res.status(400).json({ ok: false, error: "invalid_booking_self" });
  }
  if (!Number.isFinite(scheduledStartAt) || !Number.isFinite(scheduledEndAt)) {
    return res.status(400).json({ ok: false, error: "invalid_schedule" });
  }
  if (scheduledEndAt <= scheduledStartAt) {
    return res.status(400).json({ ok: false, error: "invalid_schedule_range" });
  }
  if (!currency) {
    return res.status(400).json({ ok: false, error: "invalid_currency" });
  }
  if (totalAmountMinor == null || platformFeeMinor == null || modelPayoutMinor == null) {
    return res.status(400).json({ ok: false, error: "invalid_amount" });
  }

  const model = db
    .prepare("SELECT id, username, display_name, is_premium FROM users WHERE id = ?")
    .get(modelUserId);
  if (!model) {
    return res.status(404).json({ ok: false, error: "model_not_found" });
  }

  const bookingId = randomUUID();
  const now = nowMs();
  db.prepare(
    `INSERT INTO bookings (
      id, guest_user_id, model_user_id, status, currency,
      total_amount_minor, platform_fee_minor, model_payout_minor,
      escrow_status, escrow_reference,
      scheduled_start_at, scheduled_end_at, started_at, ended_at,
      guest_note, model_note, cancel_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    bookingId,
    guestUserId,
    modelUserId,
    "pending",
    currency,
    totalAmountMinor,
    platformFeeMinor,
    modelPayoutMinor,
    "not_funded",
    null,
    Math.trunc(scheduledStartAt),
    Math.trunc(scheduledEndAt),
    null,
    null,
    guestNote,
    "",
    "",
    now,
    now
  );

  const created = db
    .prepare(
      `SELECT id, guest_user_id, model_user_id, status, currency,
              total_amount_minor, platform_fee_minor, model_payout_minor,
              escrow_status, scheduled_start_at, scheduled_end_at, created_at
       FROM bookings WHERE id = ?`
    )
    .get(bookingId);

  return res.status(201).json({
    ok: true,
    message: "Booking request sent successfully.",
    booking: {
      id: created.id,
      guestUserId: created.guest_user_id,
      modelUserId: created.model_user_id,
      modelName: model.display_name || model.username || "Model",
      modelIsPremium: Boolean(model.is_premium),
      status: created.status,
      currency: created.currency,
      totalAmountMinor: created.total_amount_minor,
      platformFeeMinor: created.platform_fee_minor,
      modelPayoutMinor: created.model_payout_minor,
      escrowStatus: created.escrow_status,
      scheduledStartAt: created.scheduled_start_at,
      scheduledEndAt: created.scheduled_end_at,
      createdAt: created.created_at,
    },
  });
});

authRouter.get("/admin/users", requireAuth, requireAdminAccount, (req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, username, email, display_name, account_type, is_admin, is_premium, is_model, is_free_guest, nationality, languages, location, email_verified_at, created_at, banned_at, ban_reason, subscription_override
       FROM users
       ORDER BY created_at ASC`
    )
    .all();
  const users = rows.map((row) => {
    const subRow = getSubscriptionRow(db, row.id);
    const membership = resolveMembershipLabel(row, subRow);
    return {
      id: row.id,
      username: row.username,
      email: row.email || "",
      displayName: row.display_name || row.username,
      accountType: normalizeAccountType(row.account_type),
      isAdmin: Boolean(row.is_admin),
      isPremium: Boolean(row.is_premium),
      isModel: Boolean(row.is_model),
      isFreeGuest: isFreeGuestAccount(row),
      membershipLabel: membership.label,
      membershipType: membership.type,
      memberSince: row.created_at,
      nationality: row.nationality || "",
      languages: row.languages || "",
      location: row.location || "",
      emailVerified: Boolean(row.email_verified_at),
      createdAt: row.created_at,
      subscriptionOverride: normalizeSubscriptionOverride(row.subscription_override),
      ...banFieldsForProfile(row),
    };
  });
  res.json({ ok: true, users });
});

authRouter.get("/admin/users/:id/profile", requireAuth, requireAdminAccount, (req, res) => {
  const userId = String(req.params.id || "").trim();
  if (!userId) return res.status(400).json({ ok: false, error: "invalid_user" });
  const db = getDb();
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!row) return res.status(404).json({ ok: false, error: "user_not_found" });
  res.json({ ok: true, profile: rowToProfile(row) });
});

authRouter.patch("/admin/users/:id", requireAuth, requireAdminAccount, (req, res) => {
  const userId = String(req.params.id || "").trim();
  if (!userId) {
    return res.status(400).json({ ok: false, error: "invalid_user" });
  }
  const db = getDb();
  const existing = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!existing) {
    return res.status(404).json({ ok: false, error: "user_not_found" });
  }

  const displayName =
    req.body?.displayName != null
      ? String(req.body.displayName).trim().slice(0, 32) || existing.username
      : existing.display_name;
  const nationality =
    req.body?.nationality != null
      ? String(req.body.nationality).trim().slice(0, 64)
      : String(existing.nationality || "");
  const languages =
    req.body?.languages != null
      ? String(req.body.languages).trim().slice(0, 120)
      : String(existing.languages || "");
  const location =
    req.body?.location != null
      ? String(req.body.location).trim().slice(0, 120)
      : String(existing.location || "");
  const email =
    req.body?.email != null ? validateEmail(req.body.email) : validateEmail(existing.email);
  if (!email) {
    return res.status(400).json({ ok: false, error: "invalid_email" });
  }
  const accountType =
    req.body?.accountType != null
      ? normalizeAccountType(req.body.accountType)
      : normalizeAccountType(existing.account_type);
  const isAdmin = req.body?.isAdmin != null ? (req.body.isAdmin ? 1 : 0) : Number(existing.is_admin || 0);
  const isModel =
    req.body?.isModel != null ? (req.body.isModel ? 1 : 0) : Number(existing.is_model || 0);
  const isFreeMembership =
    req.body?.isFreeMembership != null
      ? req.body.isFreeMembership
        ? 1
        : 0
      : Number(existing.is_free_guest || 0);
  const prevFreeGuest = Number(existing.is_free_guest || 0);
  let isPremium = isAdmin ? 1 : isModel ? 1 : isFreeMembership ? 0 : Number(existing.is_premium || 0);
  const isFreeGuest = isAdmin || isModel ? 0 : isFreeMembership;
  const password = req.body?.password != null ? String(req.body.password || "") : "";
  const nextBanned =
    req.body?.isBanned != null ? Boolean(req.body.isBanned) : isUserBanned(existing);
  const banReason =
    req.body?.banReason != null
      ? normalizeBanReasonInput(req.body.banReason)
      : normalizeBanReasonInput(existing.ban_reason);
  const bannedAt = nextBanned ? existing.banned_at || Date.now() : null;
  const storedBanReason = nextBanned ? banReason : "";
  const isBillingTestUser = String(existing.username || "").toLowerCase() === "mr_x";
  const prevBillingOverride = normalizeSubscriptionOverride(existing.subscription_override);
  let subscriptionOverride = prevBillingOverride;
  if (req.body?.subscriptionOverride != null && isBillingTestUser) {
    subscriptionOverride = normalizeSubscriptionOverride(req.body.subscriptionOverride);
    if (subscriptionOverride === "active") {
      isPremium = 1;
    } else if (!isAdmin && !isModel) {
      isPremium = 0;
    }
  }

  if (existing.id === req.authUser.id && !isAdmin) {
    return res.status(400).json({
      ok: false,
      error: "self_admin_required",
      message: "You cannot remove your own admin role.",
    });
  }

  const emailOwner = db
    .prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id != ?")
    .get(email, existing.id);
  if (emailOwner) {
    return res.status(409).json({ ok: false, error: "email_taken" });
  }

  db.prepare(
    `UPDATE users SET email = ?, display_name = ?, account_type = ?, is_admin = ?, is_premium = ?, is_model = ?, is_free_guest = ?, nationality = ?, languages = ?, location = ?, banned_at = ?, ban_reason = ?, subscription_override = ? WHERE id = ?`
  ).run(
    email,
    displayName,
    accountType,
    isAdmin,
    isPremium,
    isModel,
    isFreeGuest,
    nationality,
    languages,
    location,
    bannedAt,
    storedBanReason,
    subscriptionOverride,
    existing.id
  );

  if (nextBanned) {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(existing.id);
  }

  const freeGuestChanged = prevFreeGuest !== isFreeGuest;
  if (freeGuestChanged) {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(existing.id);
  }

  if (password) {
    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ ok: false, error: "invalid_password" });
    }
    const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, existing.id);
  }

  if (isBillingTestUser && req.body?.subscriptionOverride != null && subscriptionOverride !== prevBillingOverride) {
    applyBillingTestOverrideState(db, existing.id, subscriptionOverride);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(existing.id);
  }

  const updated = db
    .prepare(
      `SELECT id, username, email, display_name, account_type, is_admin, is_premium, is_model, is_free_guest, nationality, languages, location, email_verified_at, created_at, banned_at, ban_reason, subscription_override
       FROM users WHERE id = ?`
    )
    .get(existing.id);
  const membership = resolveMembershipLabel(updated, getSubscriptionRow(db, updated.id));
  res.json({
    ok: true,
    sessionsInvalidated: freeGuestChanged || (isBillingTestUser && req.body?.subscriptionOverride != null && subscriptionOverride !== prevBillingOverride),
    user: {
      id: updated.id,
      username: updated.username,
      email: updated.email || "",
      displayName: updated.display_name || updated.username,
      accountType: normalizeAccountType(updated.account_type),
      isAdmin: Boolean(updated.is_admin),
      isPremium: Boolean(updated.is_premium),
      isModel: Boolean(updated.is_model),
      isFreeGuest: isFreeGuestAccount(updated),
      membershipLabel: membership.label,
      membershipType: membership.type,
      memberSince: updated.created_at,
      nationality: updated.nationality || "",
      languages: updated.languages || "",
      location: updated.location || "",
      emailVerified: Boolean(updated.email_verified_at),
      createdAt: updated.created_at,
      subscriptionOverride: normalizeSubscriptionOverride(updated.subscription_override),
      ...banFieldsForProfile(updated),
    },
  });
});

authRouter.post("/admin/users", requireAuth, requireAdminAccount, async (req, res) => {
  const username = validateUsername(req.body?.username);
  const password = validatePassword(req.body?.password);
  const email = validateEmail(req.body?.email);
  const displayName = String(req.body?.displayName || username || "").trim().slice(0, 32) || username;
  const accountType = normalizeAccountType(req.body?.accountType);
  const isAdmin = req.body?.isAdmin ? 1 : 0;
  const isModel = req.body?.isModel ? 1 : 0;
  const isPremium = isAdmin ? 1 : isModel ? 1 : 0;

  if (!username || !password || !email) {
    return res.status(400).json({ ok: false, error: "invalid_user_payload" });
  }
  const db = getDb();
  const takenUser = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(username);
  if (takenUser) return res.status(409).json({ ok: false, error: "username_taken" });
  const takenEmail = db.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE").get(email);
  if (takenEmail) return res.status(409).json({ ok: false, error: "email_taken" });

  const userId = randomUUID();
  const createdAt = nowMs();
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  db.prepare(
    `INSERT INTO users (id, username, password_hash, email, email_verified_at, display_name, gender, bio, techniques_json, custom_techniques_json, lovense_toys, created_at, account_type, is_admin, is_premium, is_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    username,
    hash,
    email,
    createdAt,
    displayName,
    "",
    "",
    "[]",
    "[]",
    "",
    createdAt,
    accountType,
    isAdmin,
    isPremium,
    isModel
  );

  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  res.status(201).json({
    ok: true,
    user: {
      id: row.id,
      username: row.username,
      email: row.email || "",
      displayName: row.display_name || row.username,
      accountType: normalizeAccountType(row.account_type),
      isAdmin: Boolean(row.is_admin),
      isPremium: Boolean(row.is_premium),
      isModel: Boolean(row.is_model),
      emailVerified: Boolean(row.email_verified_at),
      createdAt: row.created_at,
    },
  });
});

authRouter.delete("/admin/users/:id", requireAuth, requireAdminAccount, (req, res) => {
  const userId = String(req.params.id || "").trim();
  if (!userId) return res.status(400).json({ ok: false, error: "invalid_user" });
  if (userId === req.authUser.id) {
    return res.status(400).json({ ok: false, error: "cannot_delete_self" });
  }
  const db = getDb();
  const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!existing) return res.status(404).json({ ok: false, error: "user_not_found" });
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM email_verifications WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM invites WHERE used_by_user_id = ? OR host_user_id = ?").run(userId, userId);
  db.prepare(
    "DELETE FROM chat_messages WHERE thread_id IN (SELECT id FROM chat_threads WHERE user_low_id = ? OR user_high_id = ?)"
  ).run(userId, userId);
  db.prepare("DELETE FROM chat_threads WHERE user_low_id = ? OR user_high_id = ?").run(userId, userId);
  db.prepare("DELETE FROM meetings WHERE host_user_id = ? OR guest_user_id = ?").run(userId, userId);
  const hasBookings = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bookings'")
    .get();
  if (hasBookings) {
    db.prepare("DELETE FROM bookings WHERE guest_user_id = ? OR model_user_id = ?").run(userId, userId);
  }
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  res.json({ ok: true });
});

authRouter.get("/auth/status", (_req, res) => {
  res.json({
    ok: true,
    smtpConfigured: isSmtpConfigured(),
    appPublicUrl: getAppPublicUrl(),
    stratoPreset: STRATO_MAIL_PRESET,
    billingConfigured: isStripeConfigured(),
  });
});
