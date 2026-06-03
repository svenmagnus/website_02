/**
 * Persistent contact chat + session meetings (Google Meet–style flow).
 */
(function (global) {
  const CHAT_CHANNEL = "dualpeer-chat-sync";
  const MEETINGS_CHANNEL = "dualpeer-meetings-sync";
  const MEETINGS_POLL_MS = 3500;
  let meetingsPollTimer = null;
  let meetingsBroadcastChannel = null;
  const state = {
    threadId: null,
    threads: [],
    partner: null,
    inviteHost: null,
    meetings: [],
    modelPool: [],
    messages: [],
    loaded: false,
    calendar: { configured: false, connected: false, email: "" },
    renderFingerprint: null,
  };

  let chatBroadcastChannel = null;

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

  function messagesFingerprint(messages) {
    return (messages || [])
      .map((m) => `${m.id}:${m.createdAt}:${m.body}`)
      .join("\n");
  }

  function sortMessages(messages) {
    return [...messages].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  function mergeMessages(existing, incoming) {
    const byId = new Map();
    for (const m of existing || []) {
      if (m?.id) byId.set(m.id, m);
    }
    for (const m of incoming || []) {
      if (m?.id) byId.set(m.id, m);
    }
    return sortMessages([...byId.values()]);
  }

  function setMessages(next, { skipBroadcast = false } = {}) {
    const merged = sortMessages(next || []);
    const fp = messagesFingerprint(merged);
    if (fp === state.renderFingerprint) return false;
    state.messages = merged;
    state.renderFingerprint = fp;
    renderMessages({ skipBroadcast });
    return true;
  }

  function renderMessages({ skipBroadcast = false } = {}) {
    const uid = getSessionUserId();
    getPanes().forEach((pane) => {
      pane.replaceChildren();
      if (!state.messages.length) {
        const empty = document.createElement("p");
        empty.className = "chat-empty-hint";
        empty.textContent = state.partner
          ? `Chat with ${state.partner.displayName}. History clears when the video session ends.`
          : "Sign in and connect with your host to start chatting.";
        pane.appendChild(empty);
        return;
      }
      for (const m of state.messages) {
        pane.appendChild(buildMessageEl(m, uid));
      }
      pane.scrollTop = pane.scrollHeight;
    });
    if (!skipBroadcast) broadcastSync();
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
      const bc = getChatBroadcastChannel();
      if (!bc) return;
      bc.postMessage({
        type: "sync",
        messages: state.messages,
        threadId: state.threadId,
        fingerprint: state.renderFingerprint,
        sourceId: global.__dualpeerTabId,
      });
    } catch (_) {
      /* ignore */
    }
  }

  function broadcastChatClear() {
    try {
      const bc = getChatBroadcastChannel();
      if (!bc) return;
      bc.postMessage({
        type: "clear",
        threadId: state.threadId,
        sourceId: global.__dualpeerTabId,
      });
    } catch (_) {
      /* ignore */
    }
  }

  function clearLocalChatMessages({ skipBroadcast = false } = {}) {
    state.messages = [];
    state.renderFingerprint = messagesFingerprint([]);
    renderMessages({ skipBroadcast });
    if (!skipBroadcast) broadcastChatClear();
  }

  async function clearChatAfterSession() {
    const threadId = state.threadId;
    if (threadId && isLoggedIn()) {
      try {
        await api(`/api/social/chat/threads/${encodeURIComponent(threadId)}/messages`, {
          method: "DELETE",
        });
      } catch (err) {
        console.warn("[social] clear chat failed:", err);
      }
    }
    clearLocalChatMessages();
  }

  function onChatBroadcastMessage(ev) {
    const data = ev.data;
    if (data?.type === "clear") {
      if (data.sourceId && data.sourceId === global.__dualpeerTabId) return;
      if (data.threadId && state.threadId && data.threadId !== state.threadId) return;
      clearLocalChatMessages({ skipBroadcast: true });
      return;
    }
    if (data?.type !== "sync" || !Array.isArray(data.messages)) return;
    if (data.sourceId && data.sourceId === global.__dualpeerTabId) return;
    if (data.threadId && state.threadId && data.threadId !== state.threadId) return;
    if (data.fingerprint && data.fingerprint === state.renderFingerprint) return;
    state.threadId = data.threadId || state.threadId;
    state.renderFingerprint = data.fingerprint || messagesFingerprint(data.messages);
    state.messages = sortMessages(data.messages);
    renderMessages({ skipBroadcast: true });
  }

  function getChatBroadcastChannel() {
    if (chatBroadcastChannel) return chatBroadcastChannel;
    try {
      chatBroadcastChannel = new BroadcastChannel(CHAT_CHANNEL);
      chatBroadcastChannel.addEventListener("message", onChatBroadcastMessage);
      return chatBroadcastChannel;
    } catch (_) {
      return null;
    }
  }

  function listenBroadcast() {
    if (!global.__dualpeerTabId) {
      global.__dualpeerTabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    }
    getChatBroadcastChannel();
  }

  async function loadThreadMessages(threadId) {
    if (!threadId) return;
    const data = await api(`/api/social/chat/threads/${encodeURIComponent(threadId)}/messages`);
    state.threadId = threadId;
    state.loaded = true;
    setMessages(data.messages || [], { skipBroadcast: false });
  }

  async function bootstrap() {
    if (!isLoggedIn()) return;
    try {
      const data = await api("/api/social/bootstrap");
      state.inviteHost = data.inviteHost || null;
      state.meetings = data.meetings || [];
      state.calendar = data.calendar || state.calendar;
      const threads = data.threads || [];
      state.threads = threads;
      const activeThread = pickActiveThread(threads);
      if (activeThread) {
        state.partner = activeThread.partner;
        await loadThreadMessages(activeThread.id);
      } else if (state.inviteHost) {
        state.partner = state.inviteHost;
      } else {
        const fromMeeting = state.meetings.find((m) => m.threadId);
        if (fromMeeting?.threadId) {
          await loadThreadMessages(fromMeeting.threadId);
        }
      }
      await loadModelPool();
      fillPartnerSelects(threads);
      updateSetupHints();
      updateMeetingPanels();
      updateCalendarUi();
      updateHeaderChatBadge();
      applyHostPeerIdFromMeetings();
    } catch (err) {
      console.warn("[social] bootstrap failed:", err);
    }
  }

  async function refreshMeetingsFromServer() {
    if (!isLoggedIn()) return;
    const data = await api("/api/social/bootstrap");
    state.meetings = data.meetings || [];
    updateMeetingPanels();
    applyHostPeerIdFromMeetings();
    await loadModelPool();
  }

  function getSelectedPartnerUserId() {
    const sel = document.querySelector(".js-meeting-partner-select");
    return sel?.value?.trim() || "";
  }

  function pickActiveThread(threads) {
    if (!threads?.length) return null;
    const partnerId = getSelectedPartnerUserId();
    if (partnerId) {
      const match = threads.find((t) => t.partner?.id === partnerId);
      if (match) return match;
    }
    return threads[0];
  }

  async function ensureChatThread() {
    if (state.threadId) return state.threadId;
    await bootstrap();
    if (state.threadId) return state.threadId;
    const partnerId = getSelectedPartnerUserId();
    if (partnerId) {
      const t = state.threads.find((x) => x.partner?.id === partnerId);
      if (t?.id) {
        await loadThreadMessages(t.id);
        return state.threadId;
      }
    }
    const meeting = state.meetings.find((m) => m.threadId);
    if (meeting?.threadId) {
      await loadThreadMessages(meeting.threadId);
      return state.threadId;
    }
    return null;
  }

  function applyHostPeerIdFromMeetings(peerIdOverride) {
    const peerIn = document.getElementById("peerIdIn");
    if (!(peerIn instanceof HTMLInputElement)) return;
    const partnerId = getSelectedPartnerUserId();
    const waiting =
      state.meetings.find((m) => {
        if (m.isHost || (!m.hostPeerId && !peerIdOverride)) return false;
        if (partnerId) {
          const otherId = m.isHost ? m.guest?.id : m.host?.id;
          if (otherId && otherId !== partnerId) return false;
        }
        return (
          m.status === "live" || (m.mode === "instant" && m.status !== "ended")
        );
      }) ||
      state.meetings.find((m) => !m.isHost && m.hostPeerId);
    const peerId = peerIdOverride || waiting?.hostPeerId;
    if (!peerId) return;
    if (peerIn.value.trim() !== peerId) {
      peerIn.value = peerId;
      peerIn.placeholder = "Session ID (auto-filled) …";
      peerIn.dispatchEvent(new Event("input", { bubbles: true }));
      const guestStatus = document.getElementById("statusGuest");
      if (guestStatus && !global.appSessionRole?.()) {
        guestStatus.textContent = "Session ID ready — click Join Session.";
        guestStatus.className = "status-line ok";
      }
    }
  }

  function broadcastMeetingsChanged() {
    try {
      const bc = getMeetingsBroadcastChannel();
      if (!bc) return;
      bc.postMessage({ type: "meetings-changed", sourceId: global.__dualpeerTabId });
    } catch (_) {
      /* ignore */
    }
  }

  function getMeetingsBroadcastChannel() {
    if (meetingsBroadcastChannel) return meetingsBroadcastChannel;
    try {
      meetingsBroadcastChannel = new BroadcastChannel(MEETINGS_CHANNEL);
      meetingsBroadcastChannel.addEventListener("message", (ev) => {
        const data = ev.data;
        if (data?.type !== "meetings-changed") return;
        if (data.sourceId && data.sourceId === global.__dualpeerTabId) return;
        refreshMeetingsFromServer().catch(() => {});
      });
      return meetingsBroadcastChannel;
    } catch (_) {
      return null;
    }
  }

  function startMeetingsPolling() {
    stopMeetingsPolling();
    getMeetingsBroadcastChannel();
    meetingsPollTimer = setInterval(() => {
      if (document.hidden || !isLoggedIn()) return;
      refreshMeetingsFromServer().catch(() => {});
    }, MEETINGS_POLL_MS);
  }

  function stopMeetingsPolling() {
    if (meetingsPollTimer) {
      clearInterval(meetingsPollTimer);
      meetingsPollTimer = null;
    }
  }

  async function sendPersistentMessage(text, { kind } = {}) {
    const body = String(text || "").trim();
    if (!body) return null;
    const threadId = await ensureChatThread();
    if (!threadId) {
      throw new Error("No chat thread yet — choose your partner under Setup → Sessions.");
    }
    const data = await api(`/api/social/chat/threads/${encodeURIComponent(threadId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ body, kind: kind || "text" }),
    });
    const msg = data.message;
    if (msg) {
      setMessages(mergeMessages(state.messages, [msg]));
    }
    return msg;
  }

  function showChatError(msg) {
    const hint = document.querySelector(".header-chat-hint");
    if (hint) {
      hint.textContent = msg;
      hint.className = "status-line header-chat-hint err";
    }
    console.warn("[social]", msg);
  }

  function updateSetupHints() {
    const hostHint = document.getElementById("guestHostHint");
    const peerHelp = document.getElementById("peerIdHelpBox");
    if (hostHint && state.inviteHost) {
      hostHint.hidden = false;
      hostHint.innerHTML =
        `Your host: <strong>${escapeHtml(state.inviteHost.displayName)}</strong> (@${escapeHtml(state.inviteHost.username)}). ` +
        `Use <strong>Messages</strong> in the header to chat. ` +
        `When your partner starts the camera, the <strong>Session ID</strong> is filled in automatically below.`;
    }
    if (peerHelp) peerHelp.hidden = false;

    applyHostPeerIdFromMeetings();
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
        const body = document.createElement("div");
        body.className = "meeting-list-item-body";
        const partner = m.isHost ? m.guest : m.host;
        const when = m.scheduledStartAt
          ? new Date(m.scheduledStartAt).toLocaleString(undefined, {
              dateStyle: "short",
              timeStyle: "short",
            })
          : "—";
        body.innerHTML =
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
          body.appendChild(document.createElement("br"));
          body.appendChild(cal);
        }
        row.appendChild(body);
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "meeting-delete-btn";
        delBtn.title = "Remove session";
        delBtn.textContent = "Remove";
        delBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (!window.confirm("Remove this session for you and your partner?")) return;
          try {
            await deleteMeeting(m.id);
            setMeetingStatusOnAll("Session removed for both sides.", "ok");
          } catch (err) {
            setMeetingStatusOnAll(err.message || "Could not remove session.", "err");
          }
        });
        row.appendChild(delBtn);
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

  let meetingCreateInFlight = false;

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

  async function deleteMeeting(meetingId) {
    await api(`/api/social/meetings/${encodeURIComponent(meetingId)}`, { method: "DELETE" });
    await bootstrap();
    broadcastMeetingsChanged();
  }

  function setMeetingMenuOpen(block, open) {
    if (!block) return;
    block.classList.toggle("is-menu-open", open);
    const menu = block.querySelector(".js-meeting-menu");
    const btn = block.querySelector(".js-meeting-menu-btn");
    if (menu) menu.hidden = !open;
    if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function closeAllMeetingMenus() {
    document.querySelectorAll(".meeting-menu-block").forEach((b) => setMeetingMenuOpen(b, false));
  }

  async function publishHostPeerId(meetingId, hostPeerId) {
    if (!meetingId || !hostPeerId) {
      throw new Error("Missing meeting or Peer ID.");
    }
    const data = await api(`/api/social/meetings/${encodeURIComponent(meetingId)}`, {
      method: "PATCH",
      body: JSON.stringify({ hostPeerId }),
    });
    state._pendingMeetingId = null;
    await bootstrap();
    broadcastMeetingsChanged();
    return data.meeting;
  }

  async function resolveLiveMeetingId() {
    if (state._pendingMeetingId) return state._pendingMeetingId;
    let id = getActiveLiveMeetingId();
    if (id) return id;
    await bootstrap();
    return getActiveLiveMeetingId();
  }

  function getActiveLiveMeetingId() {
    if (state._pendingMeetingId) return state._pendingMeetingId;
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
      try {
        await sendPersistentMessage(text);
        const hint = document.querySelector(".header-chat-hint");
        if (hint) {
          hint.textContent =
            "Drag the title bar to move. Resize from the corner. Chat syncs with Live Chat.";
          hint.className = "status-line header-chat-hint";
        }
        if (global.DualPeerChat?.relayToPeer) global.DualPeerChat.relayToPeer(text);
      } catch (err) {
        showChatError(err.message || "Could not send message.");
        if (input) input.value = text;
      }
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
    if (!tpl?.content) return;
    if (!setupMount || setupMount.querySelector(".meeting-menu-block")) return;
    setupMount.appendChild(tpl.content.cloneNode(true));
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
        const willOpen = menu.hidden;
        closeAllMeetingMenus();
        setMeetingMenuOpen(block, willOpen);
      });

      menu.querySelectorAll("[data-meeting-action]").forEach((item) => {
        item.addEventListener("click", async (e) => {
          e.stopPropagation();
          setMeetingMenuOpen(block, false);
          const action = item.dataset.meetingAction;
          const partnerId = block.querySelector(".js-meeting-partner-select")?.value;
          if (!partnerId) {
            setMeetingStatus(block, "Select your host or guest first.", "err");
            return;
          }
          if (meetingCreateInFlight) return;
          meetingCreateInFlight = true;
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
                  ? "Instant session — click Start Camera to share your Session ID."
                  : "Instant session — wait for Session ID in Messages or below.",
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
          } finally {
            meetingCreateInFlight = false;
          }
        });
      });
    });

    document.addEventListener("click", () => closeAllMeetingMenus());
  }

  let presenceTimer = null;

  async function addModelToPool(username) {
    return api("/api/social/model-pool/add", {
      method: "POST",
      body: JSON.stringify({ username: String(username || "").trim() }),
    });
  }

  function initAddToModelPool() {
    const btn = document.getElementById("btnAddModelToPool");
    const input = document.getElementById("setupAddModelUsername");
    const status = document.getElementById("setupAddModelStatus");
    if (!btn || !input) return;

    btn.addEventListener("click", async () => {
      const username = input.value.trim();
      if (!username) {
        if (status) {
          status.hidden = false;
          status.className = "status-line err";
          status.textContent = "Enter a username (e.g. Limagno).";
        }
        input.focus();
        return;
      }
      btn.disabled = true;
      if (status) {
        status.hidden = false;
        status.className = "status-line";
        status.textContent = "Adding…";
      }
      try {
        const data = await addModelToPool(username);
        input.value = "";
        await bootstrap();
        if (status) {
          status.className = "status-line ok";
          status.textContent = data.alreadyInPool
            ? `${username} is already in your pool.`
            : `${data.model?.displayName || username} added — select them under Session with.`;
        }
      } catch (err) {
        if (status) {
          status.className = "status-line err";
          status.textContent =
            err.code === "user_not_found"
              ? `No user "${username}" found.`
              : err.message || "Could not add to pool.";
        }
      } finally {
        btn.disabled = false;
      }
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        btn.click();
      }
    });
  }

  async function loadModelPool() {
    if (!isLoggedIn()) {
      state.modelPool = [];
      renderModelPoolPanels();
      return;
    }
    try {
      const data = await api("/api/social/model-pool");
      state.modelPool = data.models || [];
      renderModelPoolPanels();
    } catch (err) {
      console.warn("[social] model pool failed:", err);
    }
  }

  function renderModelPoolPanels() {
    const targets = [
      {
        root: document.getElementById("setupModelPoolList"),
        status: document.getElementById("setupModelPoolStatus"),
      },
      { root: document.getElementById("modelPoolList"), status: document.getElementById("modelPoolStatus") },
    ];
    for (const { root, status } of targets) {
      if (!root) continue;
      root.replaceChildren();
      if (!state.modelPool.length) {
        if (status) {
          status.className = "status-line";
          status.textContent = "No members yet — invite someone or add an existing member in Setup.";
        }
        continue;
      }
      if (status) {
        status.className = "status-line ok";
        status.textContent = `${state.modelPool.length} member${state.modelPool.length === 1 ? "" : "s"}.`;
      }
      for (const m of state.modelPool) {
        const card = document.createElement("div");
        card.className = "model-card" + (m.signedIn ? " is-signed-in" : "");
        const avatarPath = m.avatarUrl || null;
        if (avatarPath) {
          const photo = document.createElement("img");
          photo.className = "model-card-photo";
          let photoSrc = avatarPath;
          try {
            photoSrc = new URL(String(avatarPath), location.origin).href;
          } catch (_) {
            photoSrc = global.DualPeerAuth?.resolveAssetUrl?.(avatarPath) || avatarPath;
          }
          photo.src = photoSrc;
          photo.alt = "";
          photo.width = 48;
          photo.height = 48;
          photo.loading = "lazy";
          card.appendChild(photo);
        }
        const head = document.createElement("div");
        head.className = "model-card-head";
        const name = document.createElement("strong");
        name.textContent = m.displayName || m.username || "Model";
        head.appendChild(name);
        if (m.signedIn) {
          const badge = document.createElement("span");
          badge.className = "model-signed-in-badge";
          badge.textContent = "Signed in";
          head.appendChild(badge);
        }
        const meta = document.createElement("span");
        meta.textContent = m.signedIn ? "Signed in now" : "Offline";
        card.appendChild(head);
        card.appendChild(meta);
        root.appendChild(card);
      }
    }
  }

  function startPresenceHeartbeat() {
    stopPresenceHeartbeat();
    const beat = () => api("/api/social/presence", { method: "POST" }).catch(() => {});
    beat();
    presenceTimer = setInterval(beat, 30_000);
  }

  function stopPresenceHeartbeat() {
    if (presenceTimer) {
      clearInterval(presenceTimer);
      presenceTimer = null;
    }
  }

  async function checkConnectAvailable({ hostPeerId, providerUserId } = {}) {
    try {
      const data = await api("/api/social/session/connect-check", {
        method: "POST",
        body: JSON.stringify({ hostPeerId, providerUserId }),
      });
      return { available: true, ...data };
    } catch (err) {
      if (err?.status === 409 || err?.code === "provider_busy") {
        return {
          available: false,
          message:
            err.message ||
            "Your partner is in another session. Please try again later.",
        };
      }
      throw err;
    }
  }

  async function endLiveSession() {
    await api("/api/social/session/end-live", { method: "POST" });
    await bootstrap();
  }

  function fillPartnerSelects(threads = []) {
    const partners = [];
    for (const m of state.modelPool || []) {
      if (m.id && !partners.some((p) => p.id === m.id)) {
        partners.push({
          id: m.id,
          username: m.username,
          displayName: m.displayName,
          accountType: "guest",
        });
      }
    }
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
        opt.textContent = `${p.displayName} (@${p.username}) · Model`;
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

  function refreshAuthUi() {
    const btn = document.getElementById("btnHeaderChat");
    const setupSessions = document.getElementById("setupSessionsField");
    const setupModelPool = document.getElementById("setupModelPoolField");
    const aboutBox = document.getElementById("tangentAboutBox");
    const peerHelp = document.getElementById("peerIdHelpBox");
    const loggedIn = isLoggedIn();
    if (btn) {
      btn.disabled = !loggedIn;
      btn.hidden = false;
    }
    if (peerHelp) peerHelp.hidden = !loggedIn;
    if (aboutBox) aboutBox.hidden = false;
    if (setupSessions) setupSessions.hidden = !loggedIn;
    if (setupModelPool) setupModelPool.hidden = !loggedIn;
    if (loggedIn) {
      bootstrap();
      startMeetingsPolling();
      startPresenceHeartbeat();
    } else {
      stopMeetingsPolling();
      stopPresenceHeartbeat();
    }
  }

  function init() {
    listenBroadcast();
    mountMeetingBlocks();
    initMeetingBlocks();
    initAddToModelPool();
    initHeaderChatSend();
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
    clearChatAfterSession,
    publishHostPeerId,
    getActiveLiveMeetingId,
    resolveLiveMeetingId,
    applyHostPeerIdFromMeetings,
    ensureChatThread,
    loadModelPool,
    addModelToPool,
    checkConnectAvailable,
    endLiveSession,
    getModelPool: () => state.modelPool,
    getThreadId: () => state.threadId,
    getMessages: () => state.messages,
    appendLocalEcho(text, senderName, { messageId } = {}) {
      const uid = getSessionUserId();
      const id = messageId || `local-${Date.now()}`;
      if (state.messages.some((m) => m.id === id)) return;
      const body = String(text || "").trim();
      if (!body) return;
      if (
        state.messages.some(
          (m) => m.body === body && Math.abs((m.createdAt || 0) - Date.now()) < 3000
        )
      ) {
        return;
      }
      setMessages(
        mergeMessages(state.messages, [
          {
            id,
            senderUserId: uid,
            senderName: senderName || "You",
            body,
            kind: "text",
            createdAt: Date.now(),
          },
        ])
      );
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
