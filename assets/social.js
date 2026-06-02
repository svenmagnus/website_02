/**
 * Persistent contact chat + session meetings (Google Meet–style flow).
 */
(function (global) {
  const CHAT_CHANNEL = "dualpeer-chat-sync";
  const state = {
    threadId: null,
    partner: null,
    inviteHost: null,
    meetings: [],
    messages: [],
    loaded: false,
    calendar: { configured: false, connected: false, email: "" },
  };

  function api(path, options = {}) {
    if (!global.DualPeerAuth?.api) {
      return Promise.reject(new Error("Not signed in"));
    }
    return global.DualPeerAuth.api(path, options);
  }

  function isLoggedIn() {
    return Boolean(global.DualPeerAuth?.isLoggedIn?.());
  }

  function getSessionUserId() {
    return global.DualPeerAuth?.getSession?.()?.user?.id || null;
  }

  function formatChatTime(ts) {
    const d = new Date(ts || Date.now());
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function getPanes() {
    return document.querySelectorAll("[data-chat-pane]");
  }

  function renderMessages() {
    const uid = getSessionUserId();
    getPanes().forEach((pane) => {
      pane.replaceChildren();
      if (!state.messages.length) {
        const empty = document.createElement("p");
        empty.className = "chat-empty-hint";
        empty.textContent = state.partner
          ? `Chat with ${state.partner.displayName}. Messages are saved between sessions.`
          : "Sign in and connect with your host to start chatting.";
        pane.appendChild(empty);
        return;
      }
      for (const m of state.messages) {
        pane.appendChild(buildMessageEl(m, uid));
      }
      pane.scrollTop = pane.scrollHeight;
    });
    broadcastSync();
  }

  function buildMessageEl(m, uid) {
    const isLocal = m.senderUserId === uid;
    const msg = document.createElement("div");
    const kind = m.kind === "system" ? "system" : isLocal ? "local" : "remote";
    msg.className = `chat-message chat-message--${kind}`;
    if (kind === "system") msg.classList.add("chat-message--system");

    const meta = document.createElement("span");
    meta.className = "chat-meta";
    meta.textContent = `${isLocal ? "You" : m.senderName} • ${formatChatTime(m.createdAt)}`;

    const textNode = document.createElement("span");
    textNode.className = "chat-text";
    textNode.textContent = m.body;

    msg.appendChild(meta);
    msg.appendChild(textNode);
    return msg;
  }

  function broadcastSync() {
    try {
      const bc = new BroadcastChannel(CHAT_CHANNEL);
      bc.postMessage({ type: "sync", messages: state.messages, threadId: state.threadId });
      bc.close();
    } catch (_) {
      /* ignore */
    }
  }

  function listenBroadcast() {
    try {
      const bc = new BroadcastChannel(CHAT_CHANNEL);
      bc.addEventListener("message", (ev) => {
        if (ev.data?.type !== "sync" || !Array.isArray(ev.data.messages)) return;
        if (ev.data.threadId !== state.threadId) return;
        state.messages = ev.data.messages;
        renderMessages();
      });
    } catch (_) {
      /* ignore */
    }
  }

  async function loadThreadMessages(threadId) {
    if (!threadId) return;
    const data = await api(`/api/social/chat/threads/${encodeURIComponent(threadId)}/messages`);
    state.threadId = threadId;
    state.messages = data.messages || [];
    state.loaded = true;
    renderMessages();
  }

  async function bootstrap() {
    if (!isLoggedIn()) return;
    try {
      const data = await api("/api/social/bootstrap");
      state.inviteHost = data.inviteHost || null;
      state.meetings = data.meetings || [];
      state.calendar = data.calendar || state.calendar;
      const threads = data.threads || [];
      if (threads[0]) {
        state.partner = threads[0].partner;
        await loadThreadMessages(threads[0].id);
      } else if (state.inviteHost) {
        state.partner = state.inviteHost;
      }
      fillPartnerSelects(threads);
      updateSetupHints();
      updateMeetingPanels();
      updateCalendarUi();
      updateHeaderChatBadge();
    } catch (err) {
      console.warn("[social] bootstrap failed:", err);
    }
  }

  async function sendPersistentMessage(text, { kind } = {}) {
    if (!state.threadId || !text.trim()) return null;
    const data = await api(`/api/social/chat/threads/${encodeURIComponent(state.threadId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: text, kind: kind || "text" }),
    });
    const msg = data.message;
    if (msg) {
      state.messages.push(msg);
      renderMessages();
    }
    return msg;
  }

  function updateSetupHints() {
    const hostHint = document.getElementById("guestHostHint");
    const peerHelp = document.getElementById("peerIdHelpBox");
    if (hostHint && state.inviteHost) {
      hostHint.hidden = false;
      hostHint.innerHTML =
        `Your host: <strong>${escapeHtml(state.inviteHost.displayName)}</strong> (@${escapeHtml(state.inviteHost.username)}). ` +
        `Use <strong>Messages</strong> in the header to chat — history is saved. ` +
        `When they start a session, the <strong>Host Peer ID</strong> appears in chat; paste it below.`;
    }
    if (peerHelp) peerHelp.hidden = false;

    const liveMeeting = state.meetings.find((m) => m.status === "live" && m.hostPeerId);
    const peerIn = document.getElementById("peerIdIn");
    if (liveMeeting?.hostPeerId && peerIn instanceof HTMLInputElement && !peerIn.value.trim()) {
      peerIn.value = liveMeeting.hostPeerId;
      peerIn.placeholder = "Host Peer ID from chat …";
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function updateMeetingPanels() {
    document.querySelectorAll(".js-meeting-list").forEach((list) => {
      list.replaceChildren();
      if (!state.meetings.length) {
        list.innerHTML = '<p class="status-line">No sessions yet.</p>';
        return;
      }
      for (const m of state.meetings.slice(0, 8)) {
        const row = document.createElement("div");
        row.className = "meeting-list-item";
        const partner = m.isHost ? m.guest : m.host;
        const when = m.scheduledStartAt
          ? new Date(m.scheduledStartAt).toLocaleString(undefined, {
              dateStyle: "short",
              timeStyle: "short",
            })
          : "—";
        row.innerHTML =
          `<strong>${m.mode === "instant" ? "Instant" : "Scheduled"}</strong> · ${m.status}` +
          (partner ? ` · ${escapeHtml(partner.displayName)}` : "") +
          (m.mode === "scheduled" ? `<br><span class="status-line">${when}</span>` : "") +
          (m.hostPeerId ? `<br><code class="meeting-peer-id">${escapeHtml(m.hostPeerId)}</code>` : "") +
          (m.googleEventId ? `<br><span class="status-line ok">Google Calendar synced</span>` : "");
        if (m.calendarUrl) {
          const cal = document.createElement("a");
          cal.href = m.calendarUrl;
          cal.target = "_blank";
          cal.rel = "noopener";
          cal.className = "meeting-cal-link";
          cal.textContent = m.googleEventId ? "Open in Google Calendar" : "Calendar link";
          row.appendChild(document.createElement("br"));
          row.appendChild(cal);
        }
        list.appendChild(row);
      }
    });
  }

  function updateCalendarUi() {
    document.querySelectorAll(".meeting-menu-block").forEach((block) => {
      const statusEl = block.querySelector(".js-calendar-status");
      const connectBtn = block.querySelector(".js-calendar-connect");
      const disconnectBtn = block.querySelector(".js-calendar-disconnect");
      const syncBtn = block.querySelector(".js-calendar-sync");
      if (!statusEl) return;
      if (!state.calendar.configured) {
        statusEl.textContent =
          "Google Calendar: server not configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in server/.env). Template links still work.";
        if (connectBtn) connectBtn.hidden = true;
        if (disconnectBtn) disconnectBtn.hidden = true;
        if (syncBtn) syncBtn.hidden = true;
        return;
      }
      if (state.calendar.connected) {
        statusEl.textContent = `Google Calendar connected${state.calendar.email ? `: ${state.calendar.email}` : ""}.`;
        if (connectBtn) connectBtn.hidden = true;
        if (disconnectBtn) disconnectBtn.hidden = false;
        if (syncBtn) syncBtn.hidden = false;
      } else {
        statusEl.textContent = "Google Calendar: connect for full sync (create & invite automatically).";
        if (connectBtn) connectBtn.hidden = false;
        if (disconnectBtn) disconnectBtn.hidden = true;
        if (syncBtn) syncBtn.hidden = true;
      }
    });
  }

  async function connectGoogleCalendar() {
    const data = await api("/api/social/calendar/auth-url");
    if (data.url) window.location.href = data.url;
  }

  async function disconnectGoogleCalendar() {
    await api("/api/social/calendar/disconnect", { method: "POST" });
    await bootstrap();
  }

  async function syncGoogleCalendar() {
    await api("/api/social/calendar/sync", { method: "POST" });
    setMeetingStatusOnAll("Calendar synced.", "ok");
    await bootstrap();
  }

  function updateHeaderChatBadge() {
    const btn = document.getElementById("btnHeaderChat");
    if (!btn) return;
    const n = state.messages.length;
    btn.title = n ? `Messages (${n} saved)` : "Messages";
  }

  async function createMeeting(payload) {
    const data = await api("/api/social/meetings", {
      method: "POST",
      body: JSON.stringify({
        partnerUserId: payload.partnerUserId,
        mode: payload.mode,
        scheduledStartAt: payload.scheduledStartAt,
        syncGoogle: payload.syncGoogle ?? Boolean(state.calendar.connected),
      }),
    });
    await bootstrap();
    return data.meeting;
  }

  async function publishHostPeerId(meetingId, hostPeerId) {
    if (!meetingId || !hostPeerId) return;
    await api(`/api/social/meetings/${encodeURIComponent(meetingId)}`, {
      method: "PATCH",
      body: JSON.stringify({ hostPeerId }),
    });
    await bootstrap();
  }

  function getActiveLiveMeetingId() {
    const m = state.meetings.find(
      (x) => x.isHost && (x.status === "live" || x.status === "scheduled") && x.mode === "instant"
    );
    return m?.id || state.meetings.find((x) => x.isHost && x.status === "live")?.id || null;
  }

  function initHeaderChatSend() {
    const sendHeader = async () => {
      const input = document.getElementById("headerChatInput");
      const text = input?.value?.trim();
      if (!text) return;
      input.value = "";
      await sendPersistentMessage(text);
      if (global.DualPeerChat?.relayToPeer) global.DualPeerChat.relayToPeer(text);
    };
    document.getElementById("headerChatSend")?.addEventListener("click", sendHeader);
    document.getElementById("headerChatInput")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        sendHeader();
      }
    });
  }

  function mountMeetingBlocks() {
    const tpl = document.getElementById("meetingBlockTemplate");
    const setupMount = document.getElementById("setupMeetingMount");
    const profileMount = document.getElementById("profileMeetingMount");
    if (!tpl?.content) return;
    [setupMount, profileMount].forEach((mount) => {
      if (!mount || mount.querySelector(".meeting-menu-block")) return;
      mount.appendChild(tpl.content.cloneNode(true));
    });
  }

  function setMeetingStatus(block, msg, cls) {
    const el = block?.querySelector(".js-meeting-status");
    if (!el) return;
    el.textContent = msg || "";
    el.className = cls ? `status-line js-meeting-status ${cls}` : "status-line js-meeting-status";
  }

  function setMeetingStatusOnAll(msg, cls) {
    document.querySelectorAll(".meeting-menu-block").forEach((b) => setMeetingStatus(b, msg, cls));
  }

  function initMeetingBlocks() {
    document.querySelectorAll(".meeting-menu-block").forEach((block) => {
      const btn = block.querySelector(".js-meeting-menu-btn");
      const menu = block.querySelector(".js-meeting-menu");
      if (!btn || !menu) return;

      block.querySelector(".js-calendar-connect")?.addEventListener("click", () => connectGoogleCalendar());
      block.querySelector(".js-calendar-disconnect")?.addEventListener("click", () =>
        disconnectGoogleCalendar()
      );
      block.querySelector(".js-calendar-sync")?.addEventListener("click", () => syncGoogleCalendar());

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
        btn.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
      });

      menu.querySelectorAll("[data-meeting-action]").forEach((item) => {
        item.addEventListener("click", async (e) => {
          e.stopPropagation();
          menu.hidden = true;
          btn.setAttribute("aria-expanded", "false");
          const action = item.dataset.meetingAction;
          const partnerId = block.querySelector(".js-meeting-partner-select")?.value;
          if (!partnerId) {
            setMeetingStatus(block, "Select your host or guest first.", "err");
            return;
          }
          const scheduleEl = block.querySelector(".js-meeting-schedule-start");
          try {
            if (action === "instant") {
              const meeting = await createMeeting({
                mode: "instant",
                partnerUserId: partnerId,
                syncGoogle: state.calendar.connected,
              });
              setMeetingStatus(
                block,
                global.DualPeerAuth?.isAccountHost?.()
                  ? "Instant session — click Start as Host to share your Peer ID."
                  : "Instant session — wait for host Peer ID in Messages.",
                "ok"
              );
              if (global.DualPeerAuth?.isAccountHost?.()) {
                document.getElementById("btnStartHost")?.focus();
                state._pendingMeetingId = meeting?.id;
              }
            } else if (action === "later") {
              const startVal = scheduleEl?.value;
              const startMs = startVal ? new Date(startVal).getTime() : Date.now() + 3600000;
              await createMeeting({
                mode: "scheduled",
                partnerUserId: partnerId,
                scheduledStartAt: startMs,
                syncGoogle: state.calendar.connected,
              });
              setMeetingStatus(block, "Scheduled session saved — partner notified in chat.", "ok");
            } else if (action === "calendar") {
              if (!state.calendar.connected) {
                setMeetingStatus(block, "Connect Google Calendar first for full sync.", "err");
                return;
              }
              const startMs = scheduleEl?.value
                ? new Date(scheduleEl.value).getTime()
                : Date.now() + 3600000;
              const meeting = await createMeeting({
                mode: "scheduled",
                partnerUserId: partnerId,
                scheduledStartAt: startMs,
                syncGoogle: true,
              });
              if (meeting?.calendarUrl) window.open(meeting.calendarUrl, "_blank", "noopener");
              setMeetingStatus(block, "Event created in Google Calendar and chat.", "ok");
            }
          } catch (err) {
            setMeetingStatus(block, err.message || "Could not create session.", "err");
          }
        });
      });
    });

    document.addEventListener("click", () => {
      document.querySelectorAll(".js-meeting-menu").forEach((m) => {
        m.hidden = true;
      });
      document.querySelectorAll(".js-meeting-menu-btn").forEach((b) => {
        b.setAttribute("aria-expanded", "false");
      });
    });
  }

  function fillPartnerSelects(threads = []) {
    const partners = [];
    for (const t of threads) {
      if (t.partner && !partners.some((p) => p.id === t.partner.id)) partners.push(t.partner);
    }
    if (state.inviteHost && !partners.some((p) => p.id === state.inviteHost.id)) {
      partners.unshift(state.inviteHost);
    }
    for (const m of state.meetings) {
      const p = m.isHost ? m.guest : m.host;
      if (p && !partners.some((x) => x.id === p.id)) partners.push(p);
    }
    document.querySelectorAll(".js-meeting-partner-select").forEach((sel) => {
      sel.replaceChildren();
      if (!partners.length) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "No contact yet — complete registration or get invited";
        sel.appendChild(opt);
        return;
      }
      for (const p of partners) {
        const opt = document.createElement("option");
        opt.value = p.id;
        const role = p.accountType === "host" ? "Host" : "Guest";
        opt.textContent = `${p.displayName} (@${p.username}) · ${role}`;
        sel.appendChild(opt);
      }
    });
  }

  function handleCalendarRedirect() {
    const params = new URLSearchParams(location.search);
    const cal = params.get("calendar");
    if (!cal) return;
    if (cal === "connected") {
      setMeetingStatusOnAll("Google Calendar connected.", "ok");
    } else if (cal === "error") {
      setMeetingStatusOnAll("Google Calendar connection failed.", "err");
    }
    params.delete("calendar");
    const qs = params.toString();
    history.replaceState({}, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
  }

  function initChatPopup() {
    const head = document.getElementById("chatCardHead");
    if (!head) return;
    head.addEventListener("dblclick", () => {
      const url = `${location.origin}${location.pathname}?chatPopup=1`;
      window.open(url, "tangentChat", "width=440,height=720,resizable=yes,scrollbars=yes");
    });
  }

  function initChatPopupView() {
    if (!new URLSearchParams(location.search).has("chatPopup")) return;
    document.body.classList.add("chat-popup-view");
    const panel = document.getElementById("floatingMessagesPanel");
    if (panel) panel.hidden = false;
    global.DualPeerMessagesPanel?.open?.();
  }

  function refreshAuthUi() {
    const btn = document.getElementById("btnHeaderChat");
    const profileSessions = document.getElementById("profileSessionsField");
    const setupSessions = document.getElementById("setupSessionsField");
    const aboutBox = document.getElementById("tangentAboutBox");
    const peerHelp = document.getElementById("peerIdHelpBox");
    const loggedIn = isLoggedIn();
    if (btn) {
      btn.disabled = !loggedIn;
      btn.hidden = false;
    }
    if (peerHelp) peerHelp.hidden = !loggedIn;
    if (aboutBox) aboutBox.hidden = false;
    if (profileSessions) profileSessions.hidden = !loggedIn;
    if (setupSessions) setupSessions.hidden = !loggedIn;
    if (loggedIn) bootstrap();
  }

  function init() {
    listenBroadcast();
    mountMeetingBlocks();
    initMeetingBlocks();
    initHeaderChatSend();
    initChatPopup();
    initChatPopupView();
    handleCalendarRedirect();

    global.addEventListener("dualpeer-auth-change", () => refreshAuthUi());
    if (global.DualPeerAuth?.onReady) {
      global.DualPeerAuth.onReady(() => refreshAuthUi());
    } else {
      refreshAuthUi();
    }
  }

  global.DualPeerSocial = {
    init,
    bootstrap,
    sendPersistentMessage,
    publishHostPeerId,
    getActiveLiveMeetingId,
    getThreadId: () => state.threadId,
    getMessages: () => state.messages,
    appendLocalEcho(text, senderName) {
      const uid = getSessionUserId();
      state.messages.push({
        id: `local-${Date.now()}`,
        senderUserId: uid,
        senderName: senderName || "You",
        body: text,
        kind: "text",
        createdAt: Date.now(),
      });
      renderMessages();
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
