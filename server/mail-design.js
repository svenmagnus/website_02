import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {{ themes: Record<string, { label: string, email: Record<string, string> }> }} */
let designSystem;

function loadDesignSystem() {
  if (!designSystem) {
    const raw = readFileSync(join(__dirname, "../assets/design-system.json"), "utf8");
    designSystem = JSON.parse(raw);
  }
  return designSystem;
}

export function getEmailTheme(themeId = "hippie") {
  const ds = loadDesignSystem();
  const theme = ds.themes[themeId] || ds.themes.hippie;
  return theme.email;
}

/** Botanical corner line art (inline SVG for email clients). */
function emailLeafCornerSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72" fill="none" aria-hidden="true">
  <path d="M8 64C8 64 4 40 20 24C36 8 56 12 64 8" stroke="#4A2C2A" stroke-width="1.2" stroke-linecap="round"/>
  <path d="M12 58C18 42 28 30 48 22" stroke="#4A2C2A" stroke-width="0.9" stroke-linecap="round" opacity="0.7"/>
  <ellipse cx="22" cy="38" rx="6" ry="10" transform="rotate(-35 22 38)" stroke="#4A2C2A" stroke-width="0.8" fill="none"/>
  <ellipse cx="38" cy="26" rx="5" ry="8" transform="rotate(-20 38 26)" stroke="#4A2C2A" stroke-width="0.8" fill="none"/>
</svg>`;
}

/**
 * Hippie-style email shell (invite / transactional).
 * @param {{ title: string, bodyHtml: string, footerNote?: string, publicBaseUrl: string, heroImagePath?: string }} opts
 */
export function hippieEmailLayout({
  title,
  bodyHtml,
  footerNote = "",
  publicBaseUrl,
  heroImagePath = "/assets/email/hippie-invite-hero.png",
}) {
  const t = getEmailTheme("hippie");
  const base = String(publicBaseUrl || "https://tangent-club.com").replace(/\/$/, "");
  const heroUrl = `${base}${heroImagePath.startsWith("/") ? heroImagePath : `/${heroImagePath}`}`;
  const leaf = emailLeafCornerSvg();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:${t.outerBg};font-family:${t.font};color:${t.text};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${t.outerBg};">
    <tr><td align="center" style="padding:28px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${t.cardBg};border:2px solid ${t.cardBorder};border-radius:${t.radiusLg || t.radius};overflow:hidden;">
        <tr><td style="position:relative;padding:0;">
          <div style="text-align:left;padding:8px 8px 0 8px;">${leaf}</div>
        </td></tr>
        <tr><td style="padding:8px 32px 0;text-align:center;">
          <div style="display:inline-block;padding:10px 28px;border:2px solid ${t.cardBorder};border-radius:14px;background:${t.boxBg || t.cardBg};">
            <span style="font-family:${t.fontHeading};font-size:22px;font-weight:700;color:${t.heading};letter-spacing:0.02em;">Tangent Club</span>
          </div>
        </td></tr>
        <tr><td style="padding:20px 32px 8px;text-align:center;">
          <h1 style="margin:0;font-family:${t.fontHeading};font-size:36px;font-weight:700;color:${t.heading};line-height:1.15;text-transform:lowercase;">${title}</h1>
        </td></tr>
        <tr><td style="padding:8px 32px 16px;">
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding:0 32px 24px;text-align:center;">
          <img src="${heroUrl}" alt="" width="320" style="max-width:100%;height:auto;display:block;margin:0 auto;border-radius:12px;" />
        </td></tr>
        <tr><td style="padding:0 32px 28px;font-size:12px;line-height:1.5;color:${t.textMuted};text-align:center;">
          ${footerNote}
        </td></tr>
        <tr><td style="text-align:right;padding:0 8px 8px 0;opacity:0.85;transform:scaleX(-1);">${leaf}</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function hippieEmailButton(href, label) {
  const t = getEmailTheme("hippie");
  const safeHref = String(href || "#")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
  const safeLabel = String(label || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px auto;"><tr><td align="center" style="border-radius:14px;background:${t.accent};">
    <a href="${safeHref}" style="display:inline-block;padding:14px 32px;font-family:${t.font};font-size:16px;font-weight:600;color:${t.accentText};text-decoration:none;border-radius:14px;">${safeLabel}</a>
  </td></tr></table>`;
}

export function hippieEmailBox(innerHtml) {
  const t = getEmailTheme("hippie");
  return `<div style="margin:18px 0;padding:18px 20px;border:2px solid ${t.cardBorder};border-radius:${t.radius};background:${t.boxBg || t.codeBg};line-height:1.55;color:${t.text};font-size:15px;">${innerHtml}</div>`;
}

export function hippieEmailCodeBox(label, code) {
  const t = getEmailTheme("hippie");
  return `<div style="margin:20px 0;padding:16px 20px;border:1px solid ${t.cardBorder};border-radius:${t.radius};background:${t.codeBg};text-align:center;">
    <div style="font-size:13px;color:${t.textMuted};margin-bottom:8px;">${label}</div>
    <div style="font-family:${t.fontHeading};font-size:28px;letter-spacing:0.2em;color:${t.heading};font-weight:700;">${code}</div>
  </div>`;
}

/** Legacy dark layout (SMTP test etc.) — uses cb-dark email tokens. */
export function classicEmailLayout({ title, bodyHtml, footerNote, siteName }) {
  const t = getEmailTheme("cb-dark");
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="margin:0;padding:0;background:${t.outerBg};font-family:${t.font};color:${t.text};">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:24px auto;background:${t.cardBg};border-radius:${t.radius};border:1px solid ${t.cardBorder};">
    <tr><td style="padding:28px 28px 8px;">
      <p style="margin:0 0 6px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${t.accent};">${siteName}</p>
      <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:${t.heading};">${title}</h1>
      ${bodyHtml}
    </td></tr>
    <tr><td style="padding:8px 28px 28px;font-size:12px;color:${t.textMuted};">${footerNote || ""}</td></tr>
  </table>
</body></html>`;
}
