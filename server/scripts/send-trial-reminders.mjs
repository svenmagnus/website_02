#!/usr/bin/env node
/**
 * Daily cron: node server/scripts/send-trial-reminders.mjs
 * Requires TRIAL_REMINDERS_ENABLED=true and platform SMTP in server/.env
 */
import "../load-env.js";
import { initDb } from "../db.js";
import { runTrialReminderJob } from "../trial-reminders.js";

initDb();
const result = await runTrialReminderJob();
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
