import { Router } from "express";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { getDb } from "./db.js";
import { encryptSecret } from "./smtp-crypto.js";
import {
  getAppPublicUrl,
  hashInviteCode,
  isSmtpConfigured,
  isSmtpConfiguredForUser,
  resolveMailConfig,
  sendInviteEmail,
  sendTestEmail,
  STRATO_MAIL_PRESET,
  verifySmtpConnection,
  getUserMailConfig,
} from "./mail.js";

const BCRYPT_ROUNDS = 12;
const SESSION_DAYS = 30;
const INVITE_DAYS = 7;
const VERIFY_HOURS = 48;

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

function parseBearer(req) {
  const raw = String(req.get("authorization") || "").trim();
  if (!/^Bearer\s+/i.test(raw)) return null;
  return raw.replace(/^Bearer\s+/i, "").trim();
}

function generateInviteCode() {
  return String(randomInt(100000, 1000000));
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
    createdAt: row.created_at,
    mailConfigured: isSmtpConfiguredForUser(row),
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

function parseMailSettingsBody(body) {
  const out = body?.outgoing || {};
  const inc = body?.incoming || {};
  const host = String(out.host || "").trim().slice(0, 255);
  const port = Number(out.port) || 587;
  const user = String(out.user || "").trim().slice(0, 255);
  const from = String(out.from || out.user || "").trim().slice(0, 255);
  const secure = Boolean(out.secure) || port === 465;
  const password = body?.password != null ? String(body.password) : null;

  const imapHost = String(inc.host || "").trim().slice(0, 255);
  const imapPort = Number(inc.port) || 993;
  const imapUser = String(inc.user || "").trim().slice(0, 255);
  const imapSecure = inc.secure !== false;

  if (!host || !user) {
    return { error: "invalid_mail_settings" };
  }
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
  req.authUser = user;
  req.authToken = token;
  next();
}

function validateUsername(username) {
  const u = String(username || "").trim();
  if (u.length < 3 || u.length > 24) return null;
  if (!/^[a-zA-Z0-9_]+$/.test(u)) return null;
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
  if (!normalizedEmail || !/^\d{6}$/.test(normalizedCode)) return null;

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
  return findActiveInviteByEmailAndCode(email, inviteCode);
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
    email: invite.email,
    expiresAt: invite.expires_at,
    hostName: host?.display_name || host?.username || "Host",
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
  const gender = String(req.body?.gender || "").slice(0, 32);
  const displayName = String(req.body?.displayName || username || "Guest").trim().slice(0, 32) || "Guest";
  const bio = String(req.body?.bio || "").trim().slice(0, 500);
  const techniques = Array.isArray(req.body?.techniques) ? req.body.techniques : [];
  const customTechniques = Array.isArray(req.body?.customTechniques) ? req.body.customTechniques : [];

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
  let invite = resolveInvite({ inviteToken, inviteCode, email });

  if (!invite && userCount > 0) {
    return res.status(400).json({ ok: false, error: "invite_required" });
  }
  if (invite && invite.email !== email) {
    return res.status(400).json({ ok: false, error: "email_mismatch" });
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
  let emailVerifiedAt = null;

  db.prepare(
    `INSERT INTO users (id, username, password_hash, email, email_verified_at, display_name, gender, bio, techniques_json, custom_techniques_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    createdAt
  );

  if (invite) {
    db.prepare("UPDATE invites SET used_at = ?, used_by_user_id = ? WHERE token = ?").run(
      createdAt,
      userId,
      invite.token
    );
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  let emailSent = false;

  let mailSenderRow = user;
  if (invite) {
    mailSenderRow =
      db.prepare("SELECT * FROM users WHERE id = ?").get(invite.host_user_id) || user;
  }

  if (!resolveMailConfig(mailSenderRow)) {
    markEmailVerified(userId);
    console.log(`[auth] No SMTP — ${email} auto-verified (dev / no mail config)`);
  } else {
    try {
      const sent = await sendUserVerificationEmail(user, { mailUserRow: mailSenderRow });
      emailSent = sent.mailResult.sent;
    } catch (err) {
      console.error("[mail] verification send failed:", err);
      db.prepare("DELETE FROM users WHERE id = ?").run(userId);
      return res.status(500).json({ ok: false, error: "email_failed", message: err.message });
    }
  }

  const verifiedUser = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);

  res.status(201).json({
    ok: true,
    needsEmailVerification: !verifiedUser.email_verified_at,
    emailSent,
    email,
    username,
    message: verifiedUser.email_verified_at
      ? "Konto erstellt. Du kannst dich anmelden."
      : "Konto erstellt. Bitte bestätige deine E-Mail — wir haben dir einen Link geschickt.",
  });
});

authRouter.post("/auth/login", async (req, res) => {
  const username = validateUsername(req.body?.username);
  const password = String(req.body?.password || "");
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: "invalid_credentials" });
  }

  const db = getDb();
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

  const sessionToken = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(
    sessionToken,
    user.id,
    sessionExpiry()
  );

  res.json({
    ok: true,
    token: sessionToken,
    user: rowToProfile(user),
  });
});

authRouter.post("/auth/logout", requireAuth, (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE token = ?").run(req.authToken);
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

  db.prepare(
    `UPDATE users SET display_name = ?, gender = ?, bio = ?, techniques_json = ?, custom_techniques_json = ?
     WHERE id = ?`
  ).run(
    displayName,
    gender,
    bio,
    JSON.stringify(Array.isArray(techniques) ? techniques : []),
    JSON.stringify(Array.isArray(customTechniques) ? customTechniques : []),
    req.authUser.id
  );

  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(req.authUser.id);
  res.json({ ok: true, profile: rowToProfile(updated) });
});

authRouter.get("/profile/mail", requireAuth, (req, res) => {
  res.json({
    ok: true,
    mail: rowToMailSettings(req.authUser),
    serverFallbackConfigured: isSmtpConfigured(),
    preset: STRATO_MAIL_PRESET,
  });
});

authRouter.patch("/profile/mail", requireAuth, (req, res) => {
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
      message: "E-Mail-Passwort fehlt (Strato: Postfach-Passwort).",
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

authRouter.post("/profile/mail/test", requireAuth, async (req, res) => {
  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.authUser.id);
  const config = getUserMailConfig(user);
  if (!config) {
    return res.status(400).json({
      ok: false,
      error: "mail_not_configured",
      message: "Bitte zuerst Ausgangsserver (SMTP) im Profil speichern.",
    });
  }

  const to = validateEmail(req.body?.to) || validateEmail(user.email);
  if (!to) {
    return res.status(400).json({ ok: false, error: "invalid_email" });
  }

  try {
    await verifySmtpConnection(config);
    await sendTestEmail({ to, username: user.username, userRow: user });
    res.json({
      ok: true,
      message: `Test-E-Mail wurde an ${to} gesendet.`,
    });
  } catch (err) {
    console.error("[mail] test failed:", err);
    return res.status(500).json({
      ok: false,
      error: "mail_test_failed",
      message: err.message || String(err),
    });
  }
});

authRouter.post("/invites", requireAuth, async (req, res) => {
  const email = validateEmail(req.body?.email);
  if (!email) {
    return res.status(400).json({ ok: false, error: "invalid_email" });
  }

  const inviteToken = randomBytes(24).toString("base64url");
  const inviteCode = generateInviteCode();
  const inviteCodeHash = hashInviteCode(inviteCode);
  const createdAt = nowMs();
  const expiresAt = inviteExpiry();
  const db = getDb();

  db.prepare(
    `INSERT INTO invites (token, email, host_user_id, invite_code_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(inviteToken, email, req.authUser.id, inviteCodeHash, createdAt, expiresAt);

  const inviteUrl = `${getAppPublicUrl()}/register.html?token=${encodeURIComponent(inviteToken)}`;
  const hostName = req.authUser.display_name || req.authUser.username;

  const hostRow = db.prepare("SELECT * FROM users WHERE id = ?").get(req.authUser.id);

  let mailResult = { sent: false, devMode: true };
  try {
    mailResult = await sendInviteEmail({
      to: email,
      inviteUrl,
      hostName,
      inviteCode,
      userRow: hostRow,
    });
  } catch (err) {
    console.error("[mail] send failed:", err);
    return res.status(500).json({
      ok: false,
      error: "email_failed",
      message: err.message || String(err),
    });
  }

  res.status(201).json({
    ok: true,
    email,
    inviteUrl: mailResult.devMode ? inviteUrl : undefined,
    inviteCode: mailResult.devMode ? inviteCode : undefined,
    emailSent: mailResult.sent,
    smtpConfigured: isSmtpConfiguredForUser(hostRow),
    mailSource: mailResult.source || null,
    expiresAt,
  });
});

authRouter.get("/auth/status", (_req, res) => {
  res.json({
    ok: true,
    smtpConfigured: isSmtpConfigured(),
    appPublicUrl: getAppPublicUrl(),
    stratoPreset: STRATO_MAIL_PRESET,
  });
});
