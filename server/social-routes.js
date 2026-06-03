import { Router } from "express";
import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import { getAppPublicUrl } from "./mail.js";
import { avatarUrlForUser } from "./profile-avatar.js";
import {
  buildGoogleCalendarUrl,
  isGoogleCalendarConfigured,
  createOAuthState,
  consumeOAuthState,
  getGoogleAuthUrl,
  exchangeCodeForTokens,
  storeGoogleTokens,
  fetchGoogleEmail,
  disconnectGoogleCalendar,
  getAccessTokenForUser,
  syncMeetingToGoogle,
  listCalendarEvents,
  deleteCalendarEvent,
} from "./google-calendar.js";

export const socialRouter = Router();

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

function requireAuth(req, res, next) {
  const user = getUserByToken(parseBearer(req));
  if (!user) return res.status(401).json({ ok: false, error: "unauthorized" });
  req.authUser = user;
  next();
}

function canonicalPair(userIdA, userIdB) {
  return userIdA < userIdB ? [userIdA, userIdB] : [userIdB, userIdA];
}

function userPublicRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    accountType: row.account_type === "host" ? "host" : "guest",
    avatarUrl: avatarUrlForUser(row),
  };
}

function isHostAccount(user) {
  return user?.account_type === "host";
}

function calendarStatusForUser(user) {
  return {
    configured: isGoogleCalendarConfigured(),
    connected: Boolean(user.google_refresh_token_enc),
    email: user.google_calendar_email || "",
    connectedAt: user.google_calendar_connected_at || null,
  };
}

export function ensureChatThread(db, userIdA, userIdB) {
  const [lowId, highId] = canonicalPair(userIdA, userIdB);
  let thread = db
    .prepare("SELECT * FROM chat_threads WHERE user_low_id = ? AND user_high_id = ?")
    .get(lowId, highId);
  if (thread) return thread;
  const id = randomUUID();
  const at = nowMs();
  db.prepare(
    "INSERT INTO chat_threads (id, user_low_id, user_high_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, lowId, highId, at, at);
  return db.prepare("SELECT * FROM chat_threads WHERE id = ?").get(id);
}

function insertChatMessage(db, threadId, senderUserId, body, { kind = "text" } = {}) {
  const id = randomUUID();
  const at = nowMs();
  const text = String(body || "").trim().slice(0, 2000);
  if (!text) return null;
  db.prepare(
    "INSERT INTO chat_messages (id, thread_id, sender_user_id, body, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, threadId, senderUserId, text, kind, at);
  db.prepare("UPDATE chat_threads SET updated_at = ? WHERE id = ?").run(at, threadId);
  return db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id);
}

/** After guest registers via invite — persistent contact + welcome chat. */
export function linkInviteHostToGuest(db, hostUserId, guestUserId, guestName) {
  const host = db.prepare("SELECT id, username, display_name FROM users WHERE id = ?").get(hostUserId);
  const guest = db.prepare("SELECT id, username, display_name FROM users WHERE id = ?").get(guestUserId);
  if (!host || !guest) return null;

  const thread = ensureChatThread(db, hostUserId, guestUserId);
  const name = String(guestName || guest.display_name || guest.username).trim();
  const hostLabel = host.display_name || host.username;
  const appUrl = getAppPublicUrl();

  insertChatMessage(
    db,
    thread.id,
    hostUserId,
    `Welcome ${name}! You are in ${hostLabel}'s model pool on Tangent Club. ` +
      `Use this chat anytime. When ${hostLabel} starts a session (camera first), your Connect field fills automatically.`,
    { kind: "system" }
  );

  ensureModelPoolEntry(db, hostUserId, guestUserId);

  return { threadId: thread.id, hostUserId, guestUserId };
}

const PRESENCE_ONLINE_MS = 90_000;

export function ensureModelPoolEntry(db, ownerUserId, modelUserId) {
  if (!ownerUserId || !modelUserId || ownerUserId === modelUserId) return null;
  const existing = db
    .prepare("SELECT id FROM model_pool WHERE owner_user_id = ? AND model_user_id = ?")
    .get(ownerUserId, modelUserId);
  if (existing) return existing;
  const id = randomUUID();
  const at = nowMs();
  db.prepare(
    `INSERT INTO model_pool (id, owner_user_id, model_user_id, created_at, registered_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, ownerUserId, modelUserId, at, at);
  return db.prepare("SELECT * FROM model_pool WHERE id = ?").get(id);
}

function touchPresence(db, userId) {
  db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(nowMs(), userId);
}

function isUserOnline(db, userId) {
  const row = db.prepare("SELECT last_seen_at FROM users WHERE id = ?").get(userId);
  return Boolean(row?.last_seen_at && row.last_seen_at > nowMs() - PRESENCE_ONLINE_MS);
}

function getActiveProviderSession(db, providerUserId) {
  return (
    db
      .prepare(
        `SELECT m.*, gu.display_name AS guest_display_name, gu.username AS guest_username
         FROM meetings m
         LEFT JOIN users gu ON gu.id = m.guest_user_id
         WHERE m.host_user_id = ? AND m.status = 'live' AND TRIM(m.host_peer_id) != ''
         ORDER BY m.updated_at DESC LIMIT 1`
      )
      .get(providerUserId) || null
  );
}

export function endLiveSessionsForProvider(db, providerUserId) {
  if (!providerUserId) return;
  const at = nowMs();
  db.prepare(
    `UPDATE meetings SET status = 'completed', updated_at = ? WHERE host_user_id = ? AND status = 'live'`
  ).run(at, providerUserId);
}

function resolveProviderUserId(db, { providerUserId, hostPeerId }) {
  const byId = String(providerUserId || "").trim();
  if (byId) return byId;
  const peer = String(hostPeerId || "").trim();
  if (!peer) return null;
  const row = db
    .prepare(
      `SELECT host_user_id FROM meetings WHERE host_peer_id = ? AND status = 'live'
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(peer);
  return row?.host_user_id || null;
}

function partnerIdForThread(thread, userId) {
  return thread.user_low_id === userId ? thread.user_high_id : thread.user_low_id;
}

function mapMessageRow(row, db) {
  const sender = db.prepare("SELECT id, username, display_name FROM users WHERE id = ?").get(row.sender_user_id);
  return {
    id: row.id,
    threadId: row.thread_id,
    senderUserId: row.sender_user_id,
    senderName: sender?.display_name || sender?.username || "User",
    body: row.body,
    kind: row.kind || "text",
    createdAt: row.created_at,
  };
}

socialRouter.post("/social/presence", requireAuth, (req, res) => {
  const db = getDb();
  touchPresence(db, req.authUser.id);
  res.json({ ok: true, online: true });
});

socialRouter.get("/social/model-pool", requireAuth, (req, res) => {
  const db = getDb();
  const uid = req.authUser.id;
  touchPresence(db, uid);
  const rows = db
    .prepare(
      `SELECT mp.*, u.username, u.display_name, u.last_seen_at, u.avatar_path, u.avatar_updated_at
       FROM model_pool mp
       JOIN users u ON u.id = mp.model_user_id
       WHERE mp.owner_user_id = ?
       ORDER BY COALESCE(u.last_seen_at, mp.registered_at, mp.created_at) DESC`
    )
    .all(uid);

  const models = rows.map((row) => ({
    id: row.model_user_id,
    username: row.username,
    displayName: row.display_name || row.username,
    registeredAt: row.registered_at || row.created_at,
    online: isUserOnline(db, row.model_user_id),
    signedIn: isUserOnline(db, row.model_user_id),
    avatarUrl: avatarUrlForUser(row),
  }));

  res.json({ ok: true, models });
});

socialRouter.post("/social/session/connect-check", requireAuth, (req, res) => {
  const db = getDb();
  const uid = req.authUser.id;
  touchPresence(db, uid);

  const providerUserId = resolveProviderUserId(db, {
    providerUserId: req.body?.providerUserId,
    hostPeerId: req.body?.hostPeerId,
  });
  if (!providerUserId) {
    return res.status(400).json({ ok: false, error: "provider_not_found" });
  }
  if (providerUserId === uid) {
    return res.json({ ok: true, available: true, reason: "self" });
  }

  const active = getActiveProviderSession(db, providerUserId);
  if (!active) {
    return res.json({ ok: true, available: true });
  }

  if (active.guest_user_id === uid) {
    return res.json({ ok: true, available: true, meetingId: active.id });
  }

  const consumer = userPublicRow(req.authUser);
  const consumerName = consumer?.displayName || consumer?.username || "Someone";
  const provider = userPublicRow(
    db.prepare("SELECT * FROM users WHERE id = ?").get(providerUserId)
  );
  const assignedGuest = userPublicRow(
    db.prepare("SELECT * FROM users WHERE id = ?").get(active.guest_user_id)
  );
  const thread = ensureChatThread(db, providerUserId, uid);
  const guestLabel = assignedGuest?.displayName || assignedGuest?.username || "another guest";
  insertChatMessage(
    db,
    thread.id,
    uid,
    `${consumerName} tried to connect while you are in a session with ${guestLabel}.`,
    { kind: "system" }
  );

  res.status(409).json({
    ok: false,
    available: false,
    error: "provider_busy",
      message:
      "Your partner is in another session. Please try again later.",
    providerId: providerUserId,
    providerName: provider?.displayName || provider?.username,
  });
});

socialRouter.post("/social/session/end-live", requireAuth, (req, res) => {
  const db = getDb();
  endLiveSessionsForProvider(db, req.authUser.id);
  res.json({ ok: true });
});

socialRouter.get("/social/bootstrap", requireAuth, (req, res) => {
  const db = getDb();
  const uid = req.authUser.id;
  touchPresence(db, uid);

  let threads = db
    .prepare(
      `SELECT t.* FROM chat_threads t
       WHERE t.user_low_id = ? OR t.user_high_id = ?
       ORDER BY t.updated_at DESC`
    )
    .all(uid, uid);

  const inviteHostRow = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.account_type, i.guest_name
       FROM invites i
       JOIN users u ON u.id = i.host_user_id
       WHERE i.used_by_user_id = ?
       ORDER BY i.used_at DESC LIMIT 1`
    )
    .get(uid);

  if (!threads.length && inviteHostRow) {
    try {
      linkInviteHostToGuest(db, inviteHostRow.id, uid, inviteHostRow.guest_name);
      threads = db
        .prepare(
          `SELECT t.* FROM chat_threads t
           WHERE t.user_low_id = ? OR t.user_high_id = ?
           ORDER BY t.updated_at DESC`
        )
        .all(uid, uid);
    } catch (err) {
      console.warn("[social] backfill thread failed:", err);
    }
  }

  const threadList = threads.map((t) => {
    const partnerId = partnerIdForThread(t, uid);
    const partner = userPublicRow(db.prepare("SELECT * FROM users WHERE id = ?").get(partnerId));
    const last = db
      .prepare(
        "SELECT body, created_at FROM chat_messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(t.id);
    return {
      id: t.id,
      partner,
      lastMessage: last?.body || "",
      lastMessageAt: last?.created_at || t.updated_at,
    };
  });

  const inviteHost = inviteHostRow;

  const meetings = db
    .prepare(
      `SELECT m.*, hu.username AS host_username, hu.display_name AS host_display_name,
              gu.username AS guest_username, gu.display_name AS guest_display_name
       FROM meetings m
       JOIN users hu ON hu.id = m.host_user_id
       LEFT JOIN users gu ON gu.id = m.guest_user_id
       WHERE m.host_user_id = ? OR m.guest_user_id = ?
       ORDER BY COALESCE(m.scheduled_start_at, m.created_at) DESC
       LIMIT 20`
    )
    .all(uid, uid)
    .map((m) => ({
      id: m.id,
      threadId: m.thread_id || "",
      mode: m.mode,
      status: m.status,
      hostPeerId: m.host_peer_id || "",
      scheduledStartAt: m.scheduled_start_at,
      scheduledEndAt: m.scheduled_end_at,
      calendarUrl: m.calendar_url || "",
      googleEventId: m.google_event_id || "",
      host: {
        id: m.host_user_id,
        username: m.host_username,
        displayName: m.host_display_name || m.host_username,
      },
      guest: m.guest_user_id
        ? {
            id: m.guest_user_id,
            username: m.guest_username,
            displayName: m.guest_display_name || m.guest_username,
          }
        : null,
      isHost: m.host_user_id === uid,
    }));

  res.json({
    ok: true,
    threads: threadList,
    inviteHost: inviteHost
      ? userPublicRow(inviteHost)
      : null,
    meetings,
    primaryThreadId: threadList[0]?.id || null,
    calendar: calendarStatusForUser(req.authUser),
  });
});

socialRouter.get("/social/chat/threads/:threadId/messages", requireAuth, (req, res) => {
  const db = getDb();
  const thread = db.prepare("SELECT * FROM chat_threads WHERE id = ?").get(req.params.threadId);
  if (!thread) return res.status(404).json({ ok: false, error: "thread_not_found" });
  const uid = req.authUser.id;
  if (thread.user_low_id !== uid && thread.user_high_id !== uid) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  const rows = db
    .prepare(
      "SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT 500"
    )
    .all(thread.id);
  res.json({
    ok: true,
    threadId: thread.id,
    messages: rows.map((r) => mapMessageRow(r, db)),
  });
});

socialRouter.post("/social/chat/threads/:threadId/messages", requireAuth, (req, res) => {
  const db = getDb();
  const thread = db.prepare("SELECT * FROM chat_threads WHERE id = ?").get(req.params.threadId);
  if (!thread) return res.status(404).json({ ok: false, error: "thread_not_found" });
  const uid = req.authUser.id;
  if (thread.user_low_id !== uid && thread.user_high_id !== uid) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  const row = insertChatMessage(db, thread.id, uid, req.body?.body, {
    kind: req.body?.kind === "system" ? "system" : "text",
  });
  if (!row) return res.status(400).json({ ok: false, error: "empty_message" });
  res.status(201).json({ ok: true, message: mapMessageRow(row, db) });
});

socialRouter.delete("/social/chat/threads/:threadId/messages", requireAuth, (req, res) => {
  const db = getDb();
  const thread = db.prepare("SELECT * FROM chat_threads WHERE id = ?").get(req.params.threadId);
  if (!thread) return res.status(404).json({ ok: false, error: "thread_not_found" });
  const uid = req.authUser.id;
  if (thread.user_low_id !== uid && thread.user_high_id !== uid) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  db.prepare("DELETE FROM chat_messages WHERE thread_id = ?").run(thread.id);
  db.prepare("UPDATE chat_threads SET updated_at = ? WHERE id = ?").run(nowMs(), thread.id);
  res.json({ ok: true, threadId: thread.id });
});

socialRouter.post("/social/meetings", requireAuth, async (req, res) => {
  const db = getDb();
  const mode = req.body?.mode === "scheduled" ? "scheduled" : "instant";
  const partnerUserId = String(req.body?.partnerUserId || req.body?.guestUserId || "").trim();
  const syncGoogle = Boolean(req.body?.syncGoogle);

  if (!partnerUserId) {
    return res.status(400).json({ ok: false, error: "partner_required" });
  }
  if (partnerUserId === req.authUser.id) {
    return res.status(400).json({ ok: false, error: "invalid_partner" });
  }

  const partner = db.prepare("SELECT * FROM users WHERE id = ?").get(partnerUserId);
  if (!partner) return res.status(404).json({ ok: false, error: "partner_not_found" });

  const activeLive = getActiveProviderSession(db, req.authUser.id);
  if (mode === "instant" && activeLive) {
    return res.status(409).json({
      ok: false,
      error: "provider_session_active",
      message: "You already have an active session. End it before starting a new one.",
    });
  }

  // Stream provider (camera first) = session creator; partner = consumer (Connect to Host).
  const hostUserId = req.authUser.id;
  const guestUserId = partnerUserId;
  ensureModelPoolEntry(db, req.authUser.id, partnerUserId);
  ensureModelPoolEntry(db, partnerUserId, req.authUser.id);

  const host = db.prepare("SELECT * FROM users WHERE id = ?").get(hostUserId);
  const guest = db.prepare("SELECT * FROM users WHERE id = ?").get(guestUserId);
  const thread = ensureChatThread(db, hostUserId, guestUserId);
  const at = nowMs();
  const durationMin = Math.min(240, Math.max(15, Number(req.body?.durationMinutes) || 60));
  let scheduledStart = mode === "scheduled" ? Number(req.body?.scheduledStartAt) : at;
  if (!Number.isFinite(scheduledStart) || scheduledStart < at - 60000) {
    scheduledStart = at + 15 * 60 * 1000;
  }
  const scheduledEnd = scheduledStart + durationMin * 60 * 1000;
  const status = mode === "instant" ? "live" : "scheduled";

  const meetingId = randomUUID();
  const title = `Tangent Club session — ${host.display_name || host.username} & ${guest.display_name || guest.username}`;
  const details =
    `${getAppPublicUrl()}/index.html\n\n` +
    `One partner starts the camera and shares a Session ID in chat. Partner joins via Setup → Join Session.`;
  let calendarUrl = buildGoogleCalendarUrl({
    title,
    startMs: scheduledStart,
    endMs: scheduledEnd,
    details,
  });
  let googleEventId = "";

  if (syncGoogle && req.authUser.google_refresh_token_enc) {
    try {
      const event = await syncMeetingToGoogle(
        db,
        req.authUser.id,
        { scheduled_start_at: scheduledStart, scheduled_end_at: scheduledEnd },
        { hostUser: host, guestUser: guest }
      );
      if (event?.id) {
        googleEventId = event.id;
        if (event.htmlLink) calendarUrl = event.htmlLink;
      }
    } catch (err) {
      console.error("[calendar] sync meeting failed:", err);
    }
  }

  db.prepare(
    `INSERT INTO meetings (id, host_user_id, guest_user_id, thread_id, mode, status, scheduled_start_at, scheduled_end_at, calendar_url, google_event_id, created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    meetingId,
    hostUserId,
    guestUserId,
    thread.id,
    mode,
    status,
    scheduledStart,
    scheduledEnd,
    calendarUrl,
    googleEventId,
    req.authUser.id,
    at,
    at
  );

  const creatorName = req.authUser.display_name || req.authUser.username;
  const when =
    mode === "instant"
      ? "now"
      : new Date(scheduledStart).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        });

  const hostName = host.display_name || host.username;
  insertChatMessage(
    db,
    thread.id,
    req.authUser.id,
    mode === "instant"
      ? `${creatorName} started an instant session. ${isHostAccount(host) ? `${hostName} (host) will share the Peer ID here.` : `Waiting for host ${hostName} to share the Peer ID.`}`
      : `${creatorName} scheduled a session for ${when}.${googleEventId ? " Synced to Google Calendar." : " See meeting list or calendar link."}`,
    { kind: "system" }
  );

  res.status(201).json({
    ok: true,
    meeting: {
      id: meetingId,
      mode,
      status,
      scheduledStartAt: scheduledStart,
      scheduledEndAt: scheduledEnd,
      calendarUrl,
      googleEventId,
      threadId: thread.id,
    },
  });
});

socialRouter.patch("/social/meetings/:id", requireAuth, (req, res) => {
  const db = getDb();
  const meeting = db.prepare("SELECT * FROM meetings WHERE id = ?").get(req.params.id);
  if (!meeting) return res.status(404).json({ ok: false, error: "meeting_not_found" });
  const uid = req.authUser.id;
  if (meeting.host_user_id !== uid && meeting.guest_user_id !== uid) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }

  const hostPeerId = req.body?.hostPeerId != null ? String(req.body.hostPeerId).trim().slice(0, 80) : null;
  const status = req.body?.status != null ? String(req.body.status).trim() : null;
  const at = nowMs();

  if (hostPeerId) {
    if (meeting.host_user_id !== uid) {
      return res.status(403).json({ ok: false, error: "only_host_can_publish_peer_id" });
    }
    db.prepare("UPDATE meetings SET host_peer_id = ?, status = 'live', updated_at = ? WHERE id = ?").run(
      hostPeerId,
      at,
      meeting.id
    );
    if (meeting.thread_id) {
      const hostName = req.authUser.display_name || req.authUser.username;
      insertChatMessage(
        db,
        meeting.thread_id,
        uid,
        `${hostName}'s Session ID: ${hostPeerId}\n\n` +
          `Partner: open Setup → Session ID is filled automatically → Join Session.`,
        { kind: "system" }
      );
    }
  } else if (status) {
    db.prepare("UPDATE meetings SET status = ?, updated_at = ? WHERE id = ?").run(status, at, meeting.id);
  }

  const updated = db.prepare("SELECT * FROM meetings WHERE id = ?").get(meeting.id);
  res.json({
    ok: true,
    meeting: {
      id: updated.id,
      status: updated.status,
      hostPeerId: updated.host_peer_id || "",
    },
  });
});

socialRouter.delete("/social/meetings/:id", requireAuth, async (req, res) => {
  const db = getDb();
  const meeting = db.prepare("SELECT * FROM meetings WHERE id = ?").get(req.params.id);
  if (!meeting) return res.status(404).json({ ok: false, error: "meeting_not_found" });
  const uid = req.authUser.id;
  if (meeting.host_user_id !== uid && meeting.guest_user_id !== uid) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }

  if (meeting.google_event_id && req.authUser.google_refresh_token_enc) {
    try {
      const accessToken = await getAccessTokenForUser(db, uid);
      if (accessToken) await deleteCalendarEvent(accessToken, meeting.google_event_id);
    } catch (err) {
      console.warn("[calendar] delete event failed:", err.message);
    }
  }

  db.prepare("DELETE FROM meetings WHERE id = ?").run(meeting.id);
  res.json({ ok: true });
});

socialRouter.get("/social/calendar/status", requireAuth, (req, res) => {
  res.json({ ok: true, calendar: calendarStatusForUser(req.authUser) });
});

socialRouter.get("/social/calendar/auth-url", requireAuth, (req, res) => {
  if (!isGoogleCalendarConfigured()) {
    return res.status(503).json({ ok: false, error: "google_calendar_not_configured" });
  }
  const state = createOAuthState(req.authUser.id);
  const url = getGoogleAuthUrl(state);
  res.json({ ok: true, url });
});

socialRouter.get("/social/calendar/callback", async (req, res) => {
  const db = getDb();
  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  const userId = consumeOAuthState(state);
  const appUrl = getAppPublicUrl();

  if (!code || !userId) {
    return res.redirect(`${appUrl}/index.html?calendar=error`);
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    storeGoogleTokens(db, userId, tokens);
    const email = await fetchGoogleEmail(tokens.access_token);
    if (email) {
      db.prepare("UPDATE users SET google_calendar_email = ? WHERE id = ?").run(email, userId);
    }
    return res.redirect(`${appUrl}/index.html?calendar=connected`);
  } catch (err) {
    console.error("[calendar] oauth callback failed:", err);
    return res.redirect(`${appUrl}/index.html?calendar=error`);
  }
});

socialRouter.post("/social/calendar/disconnect", requireAuth, (req, res) => {
  disconnectGoogleCalendar(getDb(), req.authUser.id);
  res.json({ ok: true });
});

socialRouter.get("/social/calendar/events", requireAuth, async (req, res) => {
  const db = getDb();
  try {
    const accessToken = await getAccessTokenForUser(db, req.authUser.id);
    if (!accessToken) {
      return res.status(400).json({ ok: false, error: "google_not_connected" });
    }
    const now = nowMs();
    const events = await listCalendarEvents(accessToken, {
      timeMin: now - 86400000,
      timeMax: now + 30 * 86400000,
    });
    res.json({ ok: true, events });
  } catch (err) {
    console.error("[calendar] list events failed:", err);
    res.status(500).json({ ok: false, error: "calendar_sync_failed", message: err.message });
  }
});

socialRouter.post("/social/calendar/sync", requireAuth, async (req, res) => {
  const db = getDb();
  try {
    const accessToken = await getAccessTokenForUser(db, req.authUser.id);
    if (!accessToken) {
      return res.status(400).json({ ok: false, error: "google_not_connected" });
    }
    const now = nowMs();
    const events = await listCalendarEvents(accessToken, {
      timeMin: now - 3600000,
      timeMax: now + 60 * 86400000,
    });
    res.json({ ok: true, events, syncedAt: now });
  } catch (err) {
    console.error("[calendar] sync failed:", err);
    res.status(500).json({ ok: false, error: "calendar_sync_failed", message: err.message });
  }
});
