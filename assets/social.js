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
      const threads = data.threads || [];
      if (threads[0]) {
        state.partner = threads[0].partner;
        await loadThreadMessages(threads[0].id);
      } else if (state.inviteHost) {
        state.partner = state.inviteHost;
      }
      fillGuestSelect(threads);
      updateSetupHints();
      updateMeetingPanel();
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

  function updateMeetingPanel() {
    const list = document.getElementById("meetingList");
    if (!list) return;
    list.replaceChildren();
    if (!state.meetings.length) {
      list.innerHTML = '<p class="status-line">No sessions yet.</p>';
      return;
    }
    for (const m of state.meetings.slice(0, 8)) {
      const row = document.createElement("div");
      row.className = "meeting-list-item";
      const when = m.scheduledStartAt
        ? new Date(m.scheduledStartAt).toLocaleString(undefined, {
            dateStyle: "short",
            timeStyle: "short",
          })
        : "—";
      row.innerHTML =
        `<strong>${m.mode === "instant" ? "Instant" : "Scheduled"}</strong> · ${m.status}` +
        (m.guest ? ` · ${escapeHtml(m.guest.displayName)}` : "") +
        (m.mode === "scheduled" ? `<br><span class="status-line">${when}</span>` : "") +
        (m.hostPeerId
          ? `<br><code class="meeting-peer-id">${escapeHtml(m.hostPeerId)}</code>`
          : "");
      if (m.calendarUrl && m.isHost) {
        const cal = document.createElement("a");
        cal.href = m.calendarUrl;
        cal.target = "_blank";
        cal.rel = "noopener";
        cal.className = "meeting-cal-link";
        cal.textContent = "Open in Google Calendar";
        row.appendChild(document.createElement("br"));
        row.appendChild(cal);
      }
      list.appendChild(row);
    }
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
      body: JSON.stringify(payload),
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

  function initHeaderChat() {
    const btn = document.getElementById("btnHeaderChat");
    const pop = document.getElementById("headerChatPopover");
    const closeBtn = document.getElementById("headerChatClose");
    if (!btn || !pop) return;

    const setOpen = (open) => {
      pop.hidden = !open;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    };

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!isLoggedIn()) {
        global.DualPeerAuth?.openPremiumLoginModal?.();
        return;
      }
      setOpen(pop.hidden);
      if (!pop.hidden) document.getElementById("headerChatInput")?.focus();
    });

    closeBtn?.addEventListener("click", () => setOpen(false));
    document.addEventListener("click", (e) => {
      if (pop.hidden) return;
      if (pop.contains(e.target) || btn.contains(e.target)) return;
      setOpen(false);
    });

    const sendHeader = async () => {
      const input = document.getElementById("headerChatInput");
      const text = input?.value?.trim();
      if (!text) return;
      input.value = "";
      await sendPersistentMessage(text);
      if (global.DualPeerChat?.relayToPeer) {
        global.DualPeerChat.relayToPeer(text);
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

  function initMeetingMenu() {
    const wrap = document.getElementById("meetingMenuWrap");
    const btn = document.getElementById("btnMeetingMenu");
    const menu = document.getElementById("meetingMenu");
    if (!wrap || !btn || !menu) return;

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!global.DualPeerAuth?.canManageInvites?.()) {
        setMeetingStatus("Only host accounts can start sessions for guests.", "err");
        return;
      }
      menu.hidden = !menu.hidden;
      btn.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
    });

    document.addEventListener("click", () => {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    });

    menu.querySelectorAll("[data-meeting-action]").forEach((item) => {
      item.addEventListener("click", async (e) => {
        e.stopPropagation();
        menu.hidden = true;
        const action = item.dataset.meetingAction;
        const guestId = document.getElementById("meetingGuestSelect")?.value;
        if (!guestId) {
          setMeetingStatus("Select a guest contact first.", "err");
          return;
        }
        try {
          if (action === "instant") {
            const meeting = await createMeeting({ mode: "instant", guestUserId: guestId });
            setMeetingStatus("Instant session created — start as Host, then share your Peer ID.", "ok");
            document.getElementById("btnStartHost")?.focus();
            state._pendingMeetingId = meeting?.id;
          } else if (action === "later") {
            const startEl = document.getElementById("meetingScheduleStart");
            const startVal = startEl?.value;
            const startMs = startVal ? new Date(startVal).getTime() : Date.now() + 3600000;
            await createMeeting({
              mode: "scheduled",
              guestUserId: guestId,
              scheduledStartAt: startMs,
            });
            setMeetingStatus("Scheduled session saved — guest notified in chat.", "ok");
          } else if (action === "calendar") {
            const startMs = Date.now() + 3600000;
            const meeting = await createMeeting({
              mode: "scheduled",
              guestUserId: guestId,
              scheduledStartAt: startMs,
            });
            if (meeting?.calendarUrl) window.open(meeting.calendarUrl, "_blank", "noopener");
            setMeetingStatus("Google Calendar opened — guest notified in chat.", "ok");
          }
          await bootstrap();
        } catch (err) {
          setMeetingStatus(err.message || "Could not create session.", "err");
        }
      });
    });
  }

  function setMeetingStatus(msg, cls) {
    const el = document.getElementById("meetingMenuStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.className = cls ? `status-line ${cls}` : "status-line";
  }

  function fillGuestSelect(threads = []) {
    const sel = document.getElementById("meetingGuestSelect");
    if (!sel) return;
    const partners = [];
    for (const t of threads) {
      if (t.partner && !partners.some((p) => p.id === t.partner.id)) partners.push(t.partner);
    }
    if (state.inviteHost && global.DualPeerAuth?.isAccountGuest?.()) {
      if (!partners.some((p) => p.id === state.inviteHost.id)) partners.unshift(state.inviteHost);
    }
    for (const m of state.meetings) {
      const p = m.isHost ? m.guest : m.host;
      if (p && !partners.some((x) => x.id === p.id)) partners.push(p);
    }
    sel.replaceChildren();
    if (!partners.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No guest contact yet — invite by email first";
      sel.appendChild(opt);
      return;
    }
    for (const p of partners) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.displayName} (@${p.username})`;
      sel.appendChild(opt);
    }
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
    const closeBtn = document.getElementById("chatPopupClose");
    closeBtn?.addEventListener("click", () => window.close());
  }

  function refreshAuthUi() {
    const btn = document.getElementById("btnHeaderChat");
    const meetingWrap = document.getElementById("meetingMenuWrap");
    const aboutBox = document.getElementById("tangentAboutBox");
    const peerHelp = document.getElementById("peerIdHelpBox");
    const loggedIn = isLoggedIn();
    if (btn) {
      btn.disabled = !loggedIn;
      btn.hidden = false;
    }
    if (peerHelp) peerHelp.hidden = !loggedIn;
    if (aboutBox) aboutBox.hidden = false;
    if (meetingWrap) {
      meetingWrap.hidden = !loggedIn || !global.DualPeerAuth?.canManageInvites?.();
    }
    if (loggedIn) bootstrap();
  }

  function init() {
    listenBroadcast();
    initHeaderChat();
    initMeetingMenu();
    initChatPopup();
    initChatPopupView();

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
