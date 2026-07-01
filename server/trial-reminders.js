import { getDb } from "./db.js";
import { resolveSubscriptionAccess } from "./billing.js";
import { getAppPublicUrl, isSmtpConfigured, sendTrialEndingReminderEmail } from "./mail.js";

export const TRIAL_REMINDER_DAYS = Math.max(1, Number(process.env.TRIAL_REMINDER_DAYS || 3));

function trialRemindersEnabled() {
  return /^(1|true|yes)$/i.test(String(process.env.TRIAL_REMINDERS_ENABLED || ""));
}

/**
 * Send trial-ending emails to users with ≤ TRIAL_REMINDER_DAYS left (once per account).
 */
export async function runTrialReminderJob() {
  if (!trialRemindersEnabled()) {
    return { ok: true, skipped: true, reason: "TRIAL_REMINDERS_ENABLED not set" };
  }
  if (!isSmtpConfigured()) {
    return { ok: false, skipped: true, reason: "SMTP not configured" };
  }

  const db = getDb();
  const now = Date.now();
  const appUrl = getAppPublicUrl();
  const rows = db
    .prepare(
      `SELECT * FROM users
       WHERE banned_at IS NULL
         AND email_verified_at IS NOT NULL
         AND TRIM(COALESCE(email, '')) != ''
         AND trial_reminder_sent_at IS NULL`
    )
    .all();

  let sent = 0;
  let checked = 0;
  for (const row of rows) {
    const access = resolveSubscriptionAccess(row);
    checked += 1;
    if (access.exempt) continue;
    if (access.phase !== "trial") continue;
    if (access.daysRemaining <= 0) continue;
    if (access.daysRemaining > TRIAL_REMINDER_DAYS) continue;

    const result = await sendTrialEndingReminderEmail({
      to: row.email,
      username: row.display_name || row.username,
      trialEndsAt: access.trialEndsAt,
      daysRemaining: access.daysRemaining,
      continueUrl: `${appUrl}/continue-subscription.html`,
      settingsUrl: `${appUrl}/settings.html#billing`,
    });

    if (!result.sent) {
      console.warn(`[trial-reminders] not sent to ${row.email} (SMTP failure?)`);
      continue;
    }

    db.prepare("UPDATE users SET trial_reminder_sent_at = ? WHERE id = ?").run(now, row.id);
    sent += 1;
    console.log(
      `[trial-reminders] sent to ${row.username} (${row.email}), ${access.daysRemaining}d left`
    );
  }

  return { ok: true, checked, sent, reminderDays: TRIAL_REMINDER_DAYS };
}
