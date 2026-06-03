import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
export const AVATARS_DIR = path.join(DATA_DIR, "uploads", "avatars");

const MAX_BYTES = 2_500_000;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

function nowMs() {
  return Date.now();
}

function parseBearer(req) {
  const h = req.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
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

export function requireAuthAvatar(req, res, next) {
  const user = getUserByToken(parseBearer(req));
  if (!user) return res.status(401).json({ ok: false, error: "unauthorized" });
  req.authUser = user;
  next();
}

export function avatarUrlForUser(row) {
  if (!row?.avatar_path) return null;
  const v = row.avatar_updated_at || 0;
  return `/api/uploads/${row.avatar_path}?v=${v}`;
}

function ensureAvatarsDir() {
  fs.mkdirSync(AVATARS_DIR, { recursive: true });
}

function extForMime(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

function parseDataUrl(dataUrl) {
  const raw = String(dataUrl || "").trim();
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/i.exec(raw);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!ALLOWED_MIME.has(mime)) return null;
  let buf;
  try {
    buf = Buffer.from(m[2], "base64");
  } catch (_) {
    return null;
  }
  if (!buf.length || buf.length > MAX_BYTES) return null;
  return { mime, buffer: buf };
}

function avatarFilePath(userId, ext) {
  return path.join(AVATARS_DIR, `${userId}.${ext}`);
}

function removeAvatarFiles(userId) {
  for (const ext of ["jpg", "jpeg", "png", "webp"]) {
    const p = path.join(AVATARS_DIR, `${userId}.${ext}`);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (_) {
      /* ignore */
    }
  }
}

export function saveUserAvatar(userId, dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return { ok: false, error: "invalid_image" };

  ensureAvatarsDir();
  removeAvatarFiles(userId);
  const ext = extForMime(parsed.mime);
  const relPath = `avatars/${userId}.${ext}`;
  const absPath = avatarFilePath(userId, ext);
  fs.writeFileSync(absPath, parsed.buffer);

  const at = nowMs();
  const db = getDb();
  db.prepare("UPDATE users SET avatar_path = ?, avatar_updated_at = ? WHERE id = ?").run(
    relPath,
    at,
    userId
  );
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  return { ok: true, avatarUrl: avatarUrlForUser(row), avatarUpdatedAt: at };
}

export function deleteUserAvatar(userId) {
  removeAvatarFiles(userId);
  const db = getDb();
  db.prepare("UPDATE users SET avatar_path = '', avatar_updated_at = NULL WHERE id = ?").run(userId);
  return { ok: true };
}

export async function handleAvatarUpload(req, res) {
  try {
    const dataUrl = req.body?.imageData ?? req.body?.dataUrl ?? req.body?.avatar;
    const result = saveUserAvatar(req.authUser.id, dataUrl);
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error, message: "Invalid image (JPEG, PNG or WebP, max 2.5 MB)." });
    }
    res.json({ ok: true, avatarUrl: result.avatarUrl });
  } catch (err) {
    console.error("[avatar] upload failed:", err);
    res.status(500).json({ ok: false, error: "upload_failed" });
  }
}

export function handleAvatarDelete(req, res) {
  try {
    deleteUserAvatar(req.authUser.id);
    res.json({ ok: true, avatarUrl: null });
  } catch (err) {
    console.error("[avatar] delete failed:", err);
    res.status(500).json({ ok: false, error: "delete_failed" });
  }
}
