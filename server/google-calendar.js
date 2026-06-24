import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret } from "./smtp-crypto.js";
import { getAppPublicUrl } from "./mail.js";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

const pendingOAuthStates = new Map();

function oauthConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ||
    `${getAppPublicUrl()}/api/social/calendar/callback`;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri };
}

export function isGoogleCalendarConfigured() {
  return Boolean(oauthConfig());
}

export function createOAuthState(userId) {
  const state = randomBytes(16).toString("hex");
  pendingOAuthStates.set(state, { userId, at: Date.now() });
  for (const [key, val] of pendingOAuthStates) {
    if (Date.now() - val.at > 15 * 60 * 1000) pendingOAuthStates.delete(key);
  }
  return state;
}

export function consumeOAuthState(state) {
  const row = pendingOAuthStates.get(String(state || ""));
  if (!row) return null;
  pendingOAuthStates.delete(state);
  if (Date.now() - row.at > 15 * 60 * 1000) return null;
  return row.userId;
}

export function getGoogleAuthUrl(state) {
  const cfg = oauthConfig();
  if (!cfg) return null;
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function postForm(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function exchangeCodeForTokens(code) {
  const cfg = oauthConfig();
  if (!cfg) throw new Error("google_calendar_not_configured");
  return postForm("https://oauth2.googleapis.com/token", {
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: "authorization_code",
  });
}

export async function refreshAccessToken(refreshToken) {
  const cfg = oauthConfig();
  if (!cfg) throw new Error("google_calendar_not_configured");
  return postForm("https://oauth2.googleapis.com/token", {
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "refresh_token",
  });
}

export async function fetchGoogleEmail(accessToken) {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return "";
  const data = await res.json();
  return data.email || "";
}

export function storeGoogleTokens(db, userId, tokenResponse) {
  const refresh = tokenResponse.refresh_token;
  if (!refresh) {
    const row = db.prepare("SELECT google_refresh_token_enc FROM users WHERE id = ?").get(userId);
    if (!row?.google_refresh_token_enc) {
      throw new Error("google_no_refresh_token");
    }
  } else {
    db.prepare(
      `UPDATE users SET google_refresh_token_enc = ?, google_calendar_connected_at = ? WHERE id = ?`
    ).run(encryptSecret(refresh), Date.now(), userId);
  }
}

export async function getAccessTokenForUser(db, userId) {
  const row = db.prepare("SELECT google_refresh_token_enc FROM users WHERE id = ?").get(userId);
  if (!row?.google_refresh_token_enc) return null;
  const refreshToken = decryptSecret(row.google_refresh_token_enc);
  if (!refreshToken) return null;
  const tokens = await refreshAccessToken(refreshToken);
  return tokens.access_token || null;
}

export function disconnectGoogleCalendar(db, userId) {
  db.prepare(
    `UPDATE users SET google_refresh_token_enc = '', google_calendar_email = '', google_calendar_connected_at = NULL WHERE id = ?`
  ).run(userId);
}

function toRfc3339(ms) {
  return new Date(ms).toISOString();
}

export async function createCalendarEvent(accessToken, { title, description, startMs, endMs, attendeeEmails }) {
  const attendees = (attendeeEmails || [])
    .filter(Boolean)
    .map((email) => ({ email }));
  const body = {
    summary: title,
    description,
    start: { dateTime: toRfc3339(startMs), timeZone: "UTC" },
    end: { dateTime: toRfc3339(endMs), timeZone: "UTC" },
    attendees,
    reminders: { useDefault: true },
  };
  const res = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `Calendar API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return {
    id: data.id,
    htmlLink: data.htmlLink || "",
    hangoutLink: data.hangoutLink || "",
  };
}

export async function deleteCalendarEvent(accessToken, eventId) {
  const id = String(eventId || "").trim();
  if (!id || !accessToken) return false;
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return res.ok || res.status === 404 || res.status === 410;
}

export async function listCalendarEvents(accessToken, { timeMin, timeMax, maxResults = 30 }) {
  const params = new URLSearchParams({
    timeMin: toRfc3339(timeMin),
    timeMax: toRfc3339(timeMax),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(maxResults),
  });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `Calendar API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return (data.items || []).map((ev) => ({
    id: ev.id,
    title: ev.summary || "Session",
    startMs: ev.start?.dateTime ? Date.parse(ev.start.dateTime) : null,
    endMs: ev.end?.dateTime ? Date.parse(ev.end.dateTime) : null,
    htmlLink: ev.htmlLink || "",
  }));
}

export function buildGoogleCalendarUrl({ title, startMs, endMs, details }) {
  const fmt = (ms) =>
    new Date(ms)
      .toISOString()
      .replace(/[-]/g, "")
      .replace(/[:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${fmt(startMs)}/${fmt(endMs)}`,
    details: details || "",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export async function syncMeetingToGoogle(db, userId, meeting, { hostUser, guestUser }) {
  const accessToken = await getAccessTokenForUser(db, userId);
  if (!accessToken) return null;

  const title = `Tangent Club — ${hostUser.display_name || hostUser.username} & ${guestUser.display_name || guestUser.username}`;
  const description =
    `${getAppPublicUrl()}/index.html\n\n` +
    `Click Start Camera under Setup — your partner connects automatically.\n` +
    `No manual Session ID or Join button needed.`;

  const attendeeEmails = [hostUser.email, guestUser.email].filter(Boolean);
  const event = await createCalendarEvent(accessToken, {
    title,
    description,
    startMs: meeting.scheduled_start_at,
    endMs: meeting.scheduled_end_at,
    attendeeEmails,
  });
  return event;
}
