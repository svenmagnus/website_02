#!/usr/bin/env node
/**
 * Manually confirm a user's email (when no mail arrived).
 * Usage: node scripts/verify-user.js svenmagnus
 */
import { getDb } from "../db.js";

const username = process.argv[2];
if (!username) {
  console.error("Usage: node scripts/verify-user.js <username>");
  process.exit(1);
}

const db = getDb();
const user = db.prepare("SELECT id, username, email, email_verified_at FROM users WHERE username = ? COLLATE NOCASE").get(
  username
);
if (!user) {
  console.error(`User not found: ${username}`);
  process.exit(1);
}

const at = Date.now();
db.prepare("UPDATE users SET email_verified_at = ? WHERE id = ?").run(at, user.id);
db.prepare("DELETE FROM email_verifications WHERE user_id = ?").run(user.id);

console.log(`OK — ${user.username} (${user.email || "no email"}) is verified.`);
console.log("Login at: https://www.tangent-club.com/");
