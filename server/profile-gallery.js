import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getDb } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
export const GALLERY_DIR = path.join(DATA_DIR, "uploads", "gallery");

const MAX_GALLERY_ITEMS = 6;
const MAX_BYTES = 2_500_000;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

function nowMs() {
  return Date.now();
}

function ensureGalleryDir(userId) {
  const dir = path.join(GALLERY_DIR, userId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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

export function parseGalleryJson(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === "object" && item.id && item.path)
      .map((item) => ({
        id: String(item.id),
        path: String(item.path),
        updatedAt: Number(item.updatedAt) || 0,
      }));
  } catch (_) {
    return [];
  }
}

export function galleryUrlForItem(item) {
  if (!item?.path) return null;
  const v = item.updatedAt || 0;
  return `/api/uploads/${item.path}?v=${v}`;
}

export function galleryForUserRow(row) {
  return parseGalleryJson(row?.profile_gallery_json).map((item) => ({
    id: item.id,
    url: galleryUrlForItem(item),
    updatedAt: item.updatedAt,
  }));
}

function saveGalleryJson(userId, items) {
  const db = getDb();
  db.prepare("UPDATE users SET profile_gallery_json = ? WHERE id = ?").run(
    JSON.stringify(items),
    userId
  );
}

function readGallery(userId) {
  const row = getDb().prepare("SELECT profile_gallery_json FROM users WHERE id = ?").get(userId);
  return parseGalleryJson(row?.profile_gallery_json);
}

export function addGalleryImage(userId, dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return { ok: false, error: "invalid_image" };

  const items = readGallery(userId);
  if (items.length >= MAX_GALLERY_ITEMS) {
    return { ok: false, error: "gallery_full", message: `Maximum ${MAX_GALLERY_ITEMS} photos.` };
  }

  const id = randomUUID();
  const ext = extForMime(parsed.mime);
  const relPath = `gallery/${userId}/${id}.${ext}`;
  ensureGalleryDir(userId);
  fs.writeFileSync(path.join(GALLERY_DIR, userId, `${id}.${ext}`), parsed.buffer);

  const at = nowMs();
  const next = [...items, { id, path: relPath, updatedAt: at }];
  saveGalleryJson(userId, next);
  return {
    ok: true,
    image: { id, url: galleryUrlForItem({ path: relPath, updatedAt: at }), updatedAt: at },
    gallery: next.map((item) => ({
      id: item.id,
      url: galleryUrlForItem(item),
      updatedAt: item.updatedAt,
    })),
  };
}

export function removeGalleryImage(userId, imageId) {
  const id = String(imageId || "").trim();
  if (!id) return { ok: false, error: "invalid_image_id" };

  const items = readGallery(userId);
  const target = items.find((item) => item.id === id);
  if (!target) return { ok: false, error: "not_found" };

  const abs = path.join(DATA_DIR, "uploads", target.path);
  try {
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (_) {
    /* ignore */
  }

  const next = items.filter((item) => item.id !== id);
  saveGalleryJson(userId, next);
  return {
    ok: true,
    gallery: next.map((item) => ({
      id: item.id,
      url: galleryUrlForItem(item),
      updatedAt: item.updatedAt,
    })),
  };
}

export async function handleGalleryUpload(req, res) {
  try {
    const dataUrl = req.body?.imageData ?? req.body?.dataUrl;
    const result = addGalleryImage(req.authUser.id, dataUrl);
    if (!result.ok) {
      const status = result.error === "gallery_full" ? 409 : 400;
      return res.status(status).json({
        ok: false,
        error: result.error,
        message: result.message || "Invalid image (JPEG, PNG or WebP, max 2.5 MB).",
      });
    }
    res.status(201).json(result);
  } catch (err) {
    console.error("[gallery] upload failed:", err);
    res.status(500).json({ ok: false, error: "upload_failed" });
  }
}

export function handleGalleryDelete(req, res) {
  try {
    const imageId = String(req.params.imageId || "").trim();
    const result = removeGalleryImage(req.authUser.id, imageId);
    if (!result.ok) {
      return res.status(result.error === "not_found" ? 404 : 400).json({
        ok: false,
        error: result.error,
      });
    }
    res.json(result);
  } catch (err) {
    console.error("[gallery] delete failed:", err);
    res.status(500).json({ ok: false, error: "delete_failed" });
  }
}
