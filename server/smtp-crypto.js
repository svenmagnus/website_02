import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

function deriveKey() {
  const secret = process.env.SMTP_SECRET_KEY || process.env.MEMBER_SECRET || "";
  if (!secret || secret.length < 16) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[smtp-crypto] SMTP_SECRET_KEY missing or short — set in server/.env");
    }
    return scryptSync("dualpeer-dev-only-not-for-production", "dualpeer-smtp", 32);
  }
  return scryptSync(secret, "dualpeer-smtp-v1", 32);
}

export function encryptSecret(plain) {
  const text = String(plain || "");
  if (!text) return "";
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptSecret(payload) {
  const raw = String(payload || "");
  if (!raw) return "";
  const parts = raw.split(":");
  if (parts.length !== 3) return "";
  try {
    const [ivHex, tagHex, dataHex] = parts;
    const key = deriveKey();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataHex, "hex")),
      decipher.final(),
    ]);
    return dec.toString("utf8");
  } catch (err) {
    console.warn("[smtp-crypto] decrypt failed (re-save SMTP password in profile):", err.message);
    return "";
  }
}
