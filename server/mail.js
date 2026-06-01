import nodemailer from "nodemailer";
import { createHash } from "node:crypto";
import { decryptSecret } from "./smtp-crypto.js";

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || "noreply@tangent-club.com";
const APP_PUBLIC_URL = (process.env.APP_PUBLIC_URL || "https://www.tangent-club.com").replace(/\/$/, "");
const SITE_NAME = process.env.MAIL_SITE_NAME || "Tangent Club";

/** @typedef {{ host: string, port: number, secure: boolean, user: string, pass: string, from: string, source: 'user'|'env' }} MailConfig */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function hashInviteCode(code) {
  return createHash("sha256").update(String(code).trim()).digest("hex");
}

function getGlobalMailConfig() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    user: SMTP_USER,
    pass: SMTP_PASS,
    from: SMTP_FROM,
    source: "env",
  };
}

/**
 * Build nodemailer config from a user DB row (per-host Strato etc.).
 * @param {Record<string, unknown>|null|undefined} userRow
 * @returns {MailConfig|null}
 */
export function getUserMailConfig(userRow) {
  if (!userRow?.smtp_out_host || !userRow?.smtp_out_user) return null;
  const pass = decryptSecret(userRow.smtp_out_pass_enc);
  if (!pass) return null;
  const port = Number(userRow.smtp_out_port) || 587;
  return {
    host: String(userRow.smtp_out_host).trim(),
    port,
    secure: Boolean(userRow.smtp_out_secure) || port === 465,
    user: String(userRow.smtp_out_user).trim(),
    pass,
    from: String(userRow.smtp_from || userRow.smtp_out_user).trim(),
    source: "user",
  };
}

/**
 * Prefer host profile SMTP, then server .env.
 * @param {Record<string, unknown>|null|undefined} userRow
 */
export function resolveMailConfig(userRow) {
  return getUserMailConfig(userRow) || getGlobalMailConfig();
}

export function isSmtpConfiguredForUser(userRow) {
  return Boolean(resolveMailConfig(userRow));
}

export function isSmtpConfigured() {
  return Boolean(getGlobalMailConfig());
}

function createTransport(config) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
  });
}

function emailLayout({ title, bodyHtml, footerNote }) {
  return `<!DOCTYPE html>
<html lang="de">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#0f0f12;font-family:'Segoe UI',system-ui,sans-serif;color:#e8e8ec;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:24px auto;background:#1a1a22;border-radius:12px;border:1px solid #2a2a36;">
    <tr><td style="padding:28px 28px 8px;">
      <p style="margin:0 0 6px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#f97316;">${escapeHtml(SITE_NAME)}</p>
      <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#fff;">${escapeHtml(title)}</h1>
      ${bodyHtml}
    </td></tr>
    <tr><td style="padding:8px 28px 28px;font-size:12px;color:#888;">
      ${escapeHtml(footerNote || "")}
    </td></tr>
  </table>
</body></html>`;
}

/**
 * @param {MailConfig} config
 */
async function deliverMailWithConfig(config, { to, subject, text, html }) {
  const transport = createTransport(config);
  await transport.sendMail({
    from: config.from,
    to,
    subject,
    text,
    html,
  });
  console.log(`[mail] Sent via ${config.source} (${config.host}) to ${to}: ${subject}`);
  return { sent: true, devMode: false, source: config.source };
}

/**
 * @param {{ to: string, subject: string, text: string, html: string, userRow?: Record<string, unknown>|null, logContext?: string }} opts
 */
export async function sendMail({ to, subject, text, html, userRow, logContext = "mail" }) {
  const config = resolveMailConfig(userRow);
  if (!config) {
    console.log(`[mail] No SMTP for ${logContext} — not sent to ${to}`);
    return { sent: false, devMode: true, source: null };
  }
  return deliverMailWithConfig(config, { to, subject, text, html });
}

/**
 * @param {{ to: string, inviteUrl: string, hostName: string, inviteCode: string, userRow?: Record<string, unknown>|null }} opts
 */
export async function sendInviteEmail({ to, inviteUrl, hostName, inviteCode, userRow }) {
  const subject = `${hostName} lädt dich zu ${SITE_NAME} ein`;
  const text =
    `Hallo,\n\n` +
    `${hostName} hat dich zu einer privaten Dual-Peer-Session auf ${SITE_NAME} eingeladen.\n\n` +
    `Registrierung (einmaliger Link, 7 Tage gültig):\n${inviteUrl}\n\n` +
    `Falls der Link nicht öffnet — Einladungscode: ${inviteCode}\n` +
    `(auf der Registrierungsseite eingeben, zusammen mit deiner E-Mail-Adresse)\n\n` +
    `Mit freundlichen Grüßen\n${hostName}`;

  const html = emailLayout({
    title: "Du bist eingeladen",
    bodyHtml:
      `<p style="line-height:1.55;color:#c8c8d0;">` +
      `<strong style="color:#fff;">${escapeHtml(hostName)}</strong> lädt dich zu einer privaten Session auf ${escapeHtml(SITE_NAME)} ein.</p>` +
      `<p style="margin:20px 0;"><a href="${escapeHtml(inviteUrl)}" style="display:inline-block;padding:12px 22px;background:#f97316;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Konto erstellen</a></p>` +
      `<p style="font-size:14px;color:#a0a0b0;line-height:1.5;">Oder Link kopieren:<br><span style="word-break:break-all;color:#e8e8ec;">${escapeHtml(inviteUrl)}</span></p>` +
      `<p style="margin-top:20px;padding:14px;background:#12121a;border-radius:8px;font-size:14px;color:#e8e8ec;">` +
      `<strong>Einladungscode</strong> (einmalig, 7 Tage): <code style="font-size:18px;letter-spacing:0.15em;color:#f97316;">${escapeHtml(inviteCode)}</code></p>`,
    footerNote: "Dieser Link und Code sind nur für dich bestimmt und verfallen nach 7 Tagen.",
  });

  const result = await sendMail({
    to,
    subject,
    text,
    html,
    userRow,
    logContext: "invite",
  });

  if (result.devMode) {
    console.log(
      `[mail] Invite (manual) for ${to}:\n  ${inviteUrl}\n  Code: ${inviteCode}`
    );
  }
  return result;
}

/**
 * @param {{ to: string, verifyUrl: string, username: string, userRow?: Record<string, unknown>|null }} opts
 */
export async function sendTestEmail({ to, username, userRow }) {
  const subject = `${SITE_NAME} — SMTP-Test`;
  const text =
    `Hallo ${username},\n\n` +
    `dein E-Mail-Ausgangsserver ist korrekt eingerichtet. Du kannst jetzt Gäste per E-Mail einladen.\n\n` +
    `${SITE_NAME}`;

  const html = emailLayout({
    title: "SMTP-Test erfolgreich",
    bodyHtml:
      `<p style="line-height:1.55;color:#c8c8d0;">Hallo <strong style="color:#fff;">${escapeHtml(username)}</strong>,</p>` +
      `<p style="line-height:1.55;color:#c8c8d0;">dein <strong>Ausgangsserver (SMTP)</strong> funktioniert. Einladungen werden von deiner E-Mail-Adresse versendet.</p>`,
    footerNote: "Diese Nachricht dient nur dem Verbindungstest.",
  });

  return sendMail({ to, subject, text, html, userRow, logContext: "test" });
}

export async function sendVerificationEmail({ to, verifyUrl, username, userRow }) {
  const subject = `Bitte bestätige dein ${SITE_NAME}-Konto`;
  const text =
    `Hallo ${username},\n\n` +
    `bitte bestätige deine E-Mail-Adresse, um dein Konto zu aktivieren:\n\n${verifyUrl}\n\n` +
    `Der Link ist 48 Stunden gültig.\n\n${SITE_NAME}`;

  const html = emailLayout({
    title: "E-Mail bestätigen",
    bodyHtml:
      `<p style="line-height:1.55;color:#c8c8d0;">Hallo <strong style="color:#fff;">${escapeHtml(username)}</strong>,</p>` +
      `<p style="line-height:1.55;color:#c8c8d0;">bitte bestätige deine E-Mail-Adresse:</p>` +
      `<p style="margin:20px 0;"><a href="${escapeHtml(verifyUrl)}" style="display:inline-block;padding:12px 22px;background:#f97316;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">E-Mail bestätigen</a></p>` +
      `<p style="font-size:13px;color:#888;word-break:break-all;">${escapeHtml(verifyUrl)}</p>`,
    footerNote: "Link 48 Stunden gültig.",
  });

  const result = await sendMail({
    to,
    subject,
    text,
    html,
    userRow,
    logContext: "verify",
  });

  if (result.devMode) {
    console.log(`[mail] Verify (manual) for ${to}:\n  ${verifyUrl}`);
  }
  return result;
}

/**
 * @param {MailConfig} config
 */
export async function verifySmtpConnection(config) {
  const transport = createTransport(config);
  await transport.verify();
  return true;
}

export function getAppPublicUrl() {
  return APP_PUBLIC_URL;
}

export const STRATO_MAIL_PRESET = {
  outgoing: {
    host: "smtp.strato.de",
    port: 465,
    secure: true,
    user: "",
    from: "",
  },
  incoming: {
    host: "imap.strato.de",
    port: 993,
    secure: true,
    user: "",
  },
};
