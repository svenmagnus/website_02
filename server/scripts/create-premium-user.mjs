#!/usr/bin/env node
import "../load-env.js";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { initDb, getDb } from "../db.js";

const username = process.argv[2] || "Mr_X";
const password = process.argv[3] || "";
const email = process.argv[4] || `${username.toLowerCase()}@tangent-club.test`;

if (!password || password.length < 8) {
  console.error("Usage: node scripts/create-premium-user.mjs <username> <password> [email]");
  process.exit(1);
}

initDb();
const db = getDb();
const now = Date.now();
const hash = await bcrypt.hash(password, 12);

const existing = db
  .prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE")
  .get(username);

if (existing) {
  db.prepare(
    `UPDATE users SET password_hash = ?, email = ?, email_verified_at = ?, display_name = ?,
     account_type = 'host', is_premium = 1, is_model = 1, is_admin = 0 WHERE id = ?`
  ).run(hash, email, now, username, existing.id);
  console.log(JSON.stringify({ action: "updated", username, isPremium: true, isModel: true, id: existing.id }));
} else {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (
      id, username, password_hash, email, email_verified_at, display_name,
      gender, bio, techniques_json, custom_techniques_json, lovense_toys,
      created_at, account_type, is_admin, is_premium, is_model
    ) VALUES (?, ?, ?, ?, ?, ?, '', '', '[]', '[]', '', ?, 'host', 0, 1, 1)`
  ).run(id, username, hash, email, now, username, now);
  console.log(JSON.stringify({ action: "created", username, isPremium: true, isModel: true, id }));
}
