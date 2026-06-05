/**
 * Persistent contact chat + session meetings (Google Meet–style flow).
 */
(function (global) {
  const CHAT_CHANNEL = "dualpeer-chat-sync";
  const MEETINGS_CHANNEL = "dualpeer-meetings-sync";
  const MEETINGS_POLL_MS = 3500;
  let meetingsPollTimer = null;
  let meetingsBroadcastChannel = null;
  const ACTIVE_MEMBERS_KEY = "dualpeer-active-members-v1";
  const SESSION_PARTNER_KEY = "dualpeer-session-partner-v1";
  let couplingPartner = false;

  const state = {
    threadId: null,
    threads: [],
    partner: null,
    inviteHost: null,
    meetings: [],
    modelPool: [],
    contactPool: [],
    activeMembers: [],
    sessionPartnerId: null,
    messages: [],
    loaded: false,
    calendar: { configured: false, connected: false, email: "" },
    renderFingerprint: null,
    activeUserId: null,
    sessionJoinedMeetingId: null,
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

  function loadActiveMembersFromStorage() {
    const uid = getSessionUserId();
    if (!uid) return [];
    try {
      const all = JSON.parse(localStorage.getItem(ACTIVE_MEMBERS_KEY) || "{}");
      return Array.isArray(all[uid]) ? all[uid] : [];
    } catch (_) {
      return [];
    }
  }

  function saveActiveMembersToStorage(list) {
    const uid = getSessionUserId();
    if (!uid) return;
    try {
      const all = JSON.parse(localStorage.getItem(ACTIVE_MEMBERS_KEY) || "{}");
      all[uid] = list;
      localStorage.setItem(ACTIVE_MEMBERS_KEY, JSON.stringify(all));
    } catch (_) {
      /* ignore */
    }
  }

  function clearActiveMembersStorage(userId) {
    const uid = userId || getSessionUserId();
    if (!uid) return;
    try {
      const all = JSON.parse(localStorage.getItem(ACTIVE_MEMBERS_KEY) || "{}");
      delete all[uid];
      localStorage.setItem(ACTIVE_MEMBERS_KEY, JSON.stringify(all));
      const partners = JSON.parse(localStorage.getItem(SESSION_PARTNER_KEY) || "{}");
      delete partners[uid];
      localStorage.setItem(SESSION_PARTNER_KEY, JSON.stringify(partners));
    } catch (_) {
      /* ignore */
    }
  }

  function loadSessionPartnerIdFromStorage() {
    const uid = getSessionUserId();
    if (!uid) return null;
    try {
      const all = JSON.parse(localStorage.getItem(SESSION_PARTNER_KEY) || "{}");
      return all[uid] || null;
    } catch (_) {
      return null;
    }
  }

  function saveSessionPartnerIdToStorage(partnerId) {
    const uid = getSessionUserId();
    if (!uid) return;
    try {
      const all = JSON.parse(localStorage.getItem(SESSION_PARTNER_KEY) || "{}");
      if (partnerId) all[uid] = partnerId;
      else delete all[uid];
      localStorage.setItem(SESSION_PARTNER_KEY, JSON.stringify(all));
    } catch (_) {
      /* ignore */
    }
  }

  function getCoupledPartnerId() {
    if (state.sessionPartnerId) return state.sessionPartnerId;
    if (state.activeMembers.length === 1) return state.activeMembers[0].id;
    const sel = document.querySelector(".js-meeting-partner-select");
    return sel?.value?.trim() || null;
  }

  function coupleSessionWithPartner(partnerId, { addToMembers = true } = {}) {
    const id = String(partnerId || "").trim();
    if (!id) {
      state.sessionPartnerId = null;
      saveSessionPartnerIdToStorage(null);
      couplingPartner = true;
      document.querySelectorAll(".js-meeting-partner-select").forEach((sel) => {
        if (sel instanceof HTMLSelectElement) sel.value = "";
      });
      couplingPartner = false;
      renderActiveMembersPanel();
      applyHostPeerIdFromMeetings();
      updateSessionActionHighlight();
      return;
    }

    if (addToMembers) {
      const contact =
        state.contactPool.find((c) => c.id === id) ||
        state.activeMembers.find((m) => m.id === id) ||
        state.threads.find((t) => t.partner?.id === id)?.partner;
      if (contact && !state.activeMembers.some((m) => m.id === id)) {
        state.activeMembers = [...state.activeMembers, normalizeContact(contact)];
        saveActiveMembersToStorage(state.activeMembers);
      }
    }

    state.sessionPartnerId = id;
    saveSessionPartnerIdToStorage(id);

    couplingPartner = true;
    document.querySelectorAll(".js-meeting-partner-select").forEach((sel) => {
      if (sel instanceof HTMLSelectElement && [...sel.options].some((o) => o.value === id)) {
        sel.value = id;
      }
    });
    couplingPartner = false;

    renderActiveMembersPanel();
    applyHostPeerIdFromMeetings();
    updateSessionActionHighlight();
    selectPartnerById(id);
  }

  function normalizeContact(raw) {
    if (!raw?.id) return null;
    return {
      id: raw.id,
      username: raw.username,
      displayName: raw.displayName || raw.username || "Member",
      avatarUrl: raw.avatarUrl || null,
      signedIn: Boolean(raw.signedIn || raw.online),
    };
  }

  function mergeContactPools(...lists) {
    const byId = new Map();
    for (const list of lists) {
      for (const raw of list || []) {
        const c = normalizeContact(raw);
        if (!c) continue;
        const prev = byId.get(c.id);
        byId.set(c.id, prev ? { ...prev, ...c, signedIn: c.signedIn || prev.signedIn } : c);
      }
    }
    return [...byId.values()].sort((a, b) =>
      String(a.displayName).localeCompare(String(b.displayName), undefined, { sensitivity: "base" })
    );
  }

  function setContactPool(next) {
    state.contactPool = mergeContactPools(next, state.modelPool);
    renderContactPoolPanel();
  }

  function addActiveMember(raw) {
    const contact = normalizeContact(raw);
    if (!contact) return false;
    if (!state.activeMembers.some((m) => m.id === contact.id)) {
      state.activeMembers = [...state.activeMembers, contact];
      saveActiveMembersToStorage(state.activeMembers);
    }
    coupleSessionWithPartner(contact.id, { addToMembers: false });
    return true;
  }

  function removeActiveMember(memberId) {
    const id = String(memberId || "").trim();
    if (!id) return;
    state.activeMembers = state.activeMembers.filter((m) => m.id !== id);
    saveActiveMembersToStorage(state.activeMembers);
    if (state.sessionPartnerId === id) {
      coupleSessionWithPartner(state.activeMembers[0]?.id || null, { addToMembers: false });
    } else {
      renderActiveMembersPanel();
    }
    clearLiveChat({ deleteServer: true }).catch(() => {});
  }

  function clearActiveMembers({ clearStorage = true, clearChat = true } = {}) {
    state.activeMembers = [];
    state.sessionPartnerId = null;
    if (clearStorage) clearActiveMembersStorage();
    else saveSessionPartnerIdToStorage(null);
    renderActiveMembersPanel();
    couplingPartner = true;
    document.querySelectorAll(".js-meeting-partner-select").forEach((sel) => {
      if (sel instanceof HTMLSelectElement) sel.value = "";
    });
    couplingPartner = false;
    if (clearChat) clearLiveChat({ deleteServer: true }).catch(() => {});
  }

  async function selectPartnerById(partnerId) {
    const id = String(partnerId || "").trim();
    if (!id) return;
    const thread = state.threads.find((t) => t.partner?.id === id);
    if (thread?.id) {
      state.partner = thread.partner;
      state.threadId = thread.id;
      await loadThreadMessages(thread.id);
      return;
    }
    state.partner = state.contactPool.find((c) => c.id === id) || null;
  }

  function buildMemberCard(m, { variant, onRemove, onActivate, onSelect, selected } = {}) {
    const card = document.createElement("div");
    card.className = "model-card" + (m.signedIn ? " is-signed-in" : "");
    if (variant === "pool") {
      card.classList.add("model-card--pool");
      card.title = "Double-click to add to Members";
    }
    if (variant === "active") {
      card.classList.add("model-card--active");
      if (selected) card.classList.add("is-session-partner");
      card.title = "Click to set as Session with partner";
      if (onSelect) {
        card.addEventListener("click", () => onSelect(m));
      }
    }

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
    name.textContent = m.displayName || m.username || "Member";
    head.appendChild(name);
    if (m.signedIn) {
      const badge = document.createElement("span");
      badge.className = "model-signed-in-badge";
      badge.textContent = "Online";
      head.appendChild(badge);
    }
    if (variant === "active" && onRemove) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "model-card-remove-btn";
      removeBtn.title = "Remove from Members";
      removeBtn.setAttribute("aria-label", `Remove ${name.textContent}`);
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onRemove(m.id);
      });
      head.appendChild(removeBtn);
    }
    card.appendChild(head);

    const meta = document.createElement("span");
    meta.textContent = m.signedIn ? "Online now" : "Offline";
    card.appendChild(meta);

    if (variant === "pool" && onActivate) {
      card.addEventListener("dblclick", () => onActivate(m));
    }

    return card;
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
    const kind =
      m.kind === "system" ? "system" : m.kind === "technique" ? (isLocal ? "local" : "remote") : isLocal ? "local" : "remote";
    msg.className = `chat-message chat-message--${kind}`;
    if (kind === "system") msg.classList.add("chat-message--system");
    if (m.kind === "technique") msg.classList.add("chat-message--technique");

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

  function setChatClearStatus(msg, cls = "ok") {
    const el = document.getElementById("chatClearStatus");
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.className = `status-line chat-clear-status ${cls}`;
    el.textContent = msg;
    window.setTimeout(() => {
      if (el.textContent === msg) setChatClearStatus("");
    }, 2500);
  }

  async function clearLiveChat({ deleteServer = true } = {}) {
    const threadId = state.threadId;
    if (deleteServer && threadId && isLoggedIn()) {
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

  async function clearChatAfterSession() {
    await clearLiveChat({ deleteServer: true });
  }

  /** Wipe in-memory social UI (chat, members, meetings) — e.g. on logout or account switch. */
  function resetSocialClientState({ broadcast = true, userId = null } = {}) {
    state.threadId = null;
    state.threads = [];
    state.partner = null;
    state.inviteHost = null;
    state.meetings = [];
    state.modelPool = [];
    state.contactPool = [];
    state.activeMembers = [];
    state.sessionPartnerId = null;
    state.messages = [];
    clearActiveMembersStorage(userId || state.activeUserId);
    state.renderFingerprint = messagesFingerprint([]);
    state.loaded = false;
    state._pendingMeetingId = null;
    state.sessionJoinedMeetingId = null;

    renderMessages({ skipBroadcast: true });
    renderModelPoolPanels();
    updateMeetingPanels();
    fillPartnerSelects([]);
    updateHeaderChatBadge();

    const peerIn = document.getElementById("peerIdIn");
    if (peerIn instanceof HTMLInputElement) {
      peerIn.value = "";
      peerIn.placeholder = "Session ID …";
    }
    const guestStatus = document.getElementById("statusGuest");
    if (guestStatus && !global.appSessionRole?.()) {
      guestStatus.textContent = "";
      guestStatus.className = "status-line";
    }

    if (global.MemberProfile?.setPartnerProfile) {
      global.MemberProfile.setPartnerProfile(null);
    }

    if (broadcast) broadcastChatClear();
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

  async function bootstrap({ loadChat = false } = {}) {
    if (!isLoggedIn()) return;
    try {
      const data = await api("/api/social/bootstrap");
      state.inviteHost = data.inviteHost || null;
      state.meetings = data.meetings || [];
      state.calendar = data.calendar || state.calendar;
      const threads = data.threads || [];
      state.threads = threads;
      setContactPool(data.contacts || []);
      state.activeMembers = loadActiveMembersFromStorage().map(normalizeContact).filter(Boolean);
      const storedPartnerId = loadSessionPartnerIdFromStorage();
      state.sessionPartnerId =
        storedPartnerId && state.activeMembers.some((m) => m.id === storedPartnerId)
          ? storedPartnerId
          : state.activeMembers[0]?.id || null;

      const activeThread = pickActiveThread(threads);
      if (activeThread) {
        state.partner = activeThread.partner;
        state.threadId = activeThread.id;
        if (loadChat) {
          await loadThreadMessages(activeThread.id);
        }
      } else if (state.inviteHost) {
        state.partner = state.inviteHost;
        state.threadId = null;
      } else {
        state.partner = null;
        state.threadId = null;
      }

      if (!loadChat) {
        setMessages([], { skipBroadcast: true });
      }

      await loadModelPool();
      setContactPool([...(data.contacts || []), ...state.modelPool]);
      fillPartnerSelects(threads);
      if (state.sessionPartnerId) {
        coupleSessionWithPartner(state.sessionPartnerId, { addToMembers: false });
      } else {
        renderActiveMembersPanel();
      }
      updateSessionActionHighlight();
      updateSetupHints();
      updateMeetingPanels();
      updateCalendarUi();
      updateHeaderChatBadge();
      applyHostPeerIdFromMeetings();
      syncJoinedSessionState();
    } catch (err) {
      console.warn("[social] bootstrap failed:", err);
    }
  }

  function syncJoinedSessionState() {
    if (!state.sessionJoinedMeetingId) return;
    const meeting = state.meetings.find((m) => m.id === state.sessionJoinedMeetingId);
    if (!meeting || meeting.status !== "live" || meeting.mode !== "instant") {
      state.sessionJoinedMeetingId = null;
      global.MemberProfile?.setPartnerProfile?.(null);
      updateMeetingPanels();
      return;
    }
    const partnerId = meeting.host?.id;
    if (partnerId) {
      loadPartnerPlaybook(partnerId).catch(() => {});
    }
  }

  async function refreshMeetingsFromServer() {
    if (!isLoggedIn()) return;
    const data = await api("/api/social/bootstrap");
    state.meetings = data.meetings || [];
    setContactPool(data.contacts || []);
    updateMeetingPanels();
    applyHostPeerIdFromMeetings();
    syncJoinedSessionState();
    await loadModelPool();
    renderActiveMembersPanel();
    updateSessionActionHighlight();
  }

  function getSelectedPartnerUserId() {
    if (state.sessionPartnerId) return state.sessionPartnerId;
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

  function findPartnerLiveMeeting() {
    const partnerId = getSelectedPartnerUserId();
    const uid = getSessionUserId();
    if (!uid) return null;
    for (const m of state.meetings || []) {
      const peerId = String(m.hostPeerId || "").trim();
      if (!peerId) continue;
      if (m.status !== "live") continue;
      const providerId = m.host?.id;
      if (!providerId || providerId === uid) continue;
      if (partnerId && providerId !== partnerId) continue;
      return m;
    }
    return null;
  }

  function findMyPendingProviderMeeting() {
    const partnerId = getSelectedPartnerUserId();
    return (
      state.meetings?.find((m) => {
        if (!m.isHost || m.mode !== "instant") return false;
        if (m.status !== "live" && m.status !== "completed") return false;
        if (String(m.hostPeerId || "").trim()) return false;
        if (partnerId && m.guest?.id !== partnerId) return false;
        return true;
      }) || null
    );
  }

  async function loadPartnerPlaybook(partnerUserId) {
    const id = String(partnerUserId || "").trim();
    if (!id) return null;
    const data = await api(`/api/social/partners/${encodeURIComponent(id)}/playbook`);
    const profile = data.profile;
    if (profile && global.MemberProfile?.setPartnerProfile) {
      global.MemberProfile.setPartnerProfile(profile);
    }
    return profile;
  }

  async function joinInstantMeeting(meeting) {
    if (!meeting?.id) throw new Error("Session not found.");
    const partner = meeting.host;
    if (!partner?.id) throw new Error("Session partner missing.");
    coupleSessionWithPartner(partner.id, { addToMembers: true });
    if (meeting.threadId) {
      await loadThreadMessages(meeting.threadId);
    } else {
      await selectPartnerById(partner.id);
    }
    state.sessionJoinedMeetingId = meeting.id;
    await loadPartnerPlaybook(partner.id);
    applyHostPeerIdFromMeetings(meeting.hostPeerId);
    updateSessionActionHighlight();
    updateMeetingPanels();
    global.dispatchEvent(
      new CustomEvent("dualpeer-session-joined", { detail: { meeting } })
    );
    if (global.MemberProfile?.setRemoteTab) {
      global.MemberProfile.setRemoteTab("techniques");
    }
    if (global.MemberProfile?.setPanelTab) {
      global.MemberProfile.setPanelTab("setup", { userAction: true });
    }
    setMeetingStatusOnAll(
      meeting.hostPeerId
        ? "Joined — Play Mode is ready. Click Share Cam to connect video."
        : "Joined — Play Mode is ready. Share Cam when your partner goes live.",
      "ok"
    );
    return meeting;
  }

  async function onPartnerDisconnected() {
    if (!state.sessionJoinedMeetingId) {
      global.MemberProfile?.setPartnerProfile?.(null);
      return;
    }
    const meeting = state.meetings.find((m) => m.id === state.sessionJoinedMeetingId);
    const partnerId = meeting?.host?.id || getSelectedPartnerUserId();
    if (partnerId) {
      try {
        await loadPartnerPlaybook(partnerId);
        return;
      } catch (_) {
        /* fall through */
      }
    }
    global.MemberProfile?.setPartnerProfile?.(null);
  }

  function isSessionJoined() {
    return Boolean(state.sessionJoinedMeetingId);
  }

  function updateSessionActionHighlight() {
    const startBtn = document.getElementById("btnStartHost");
    const joinBtn = document.getElementById("btnConnect");
    if (!startBtn || !joinBtn) return;

    const role = global.appSessionRole?.();
    const inCall = role === "host" || role === "guest";
    const partnerLive = !inCall ? findPartnerLiveMeeting() : null;
    const myTurnToStart = !inCall ? findMyPendingProviderMeeting() : null;

    startBtn.classList.remove("primary", "secondary", "session-action-glow");
    joinBtn.classList.remove("primary", "secondary", "session-action-glow");

    if (inCall) return;

    if (partnerLive) {
      joinBtn.classList.add("primary", "session-action-glow");
      startBtn.classList.add("secondary");
      if (!joinBtn.disabled) {
        joinBtn.title = "Partner is live — click Share Cam to connect video";
      }
      if (!startBtn.disabled) {
        startBtn.title = "Start your own camera (partner is already live)";
      }
      return;
    }

    if (myTurnToStart) {
      startBtn.classList.add("primary");
      joinBtn.classList.add("secondary");
      if (!startBtn.disabled) {
        startBtn.title = "Start your camera and share a Session ID";
      }
      return;
    }

    startBtn.classList.add("secondary");
    joinBtn.classList.add("secondary");
    if (!startBtn.disabled) {
      startBtn.title = "Start your camera and share a Session ID";
    }
    if (!joinBtn.disabled) {
      joinBtn.title = "Share your camera with your partner's session";
    }
  }

  function applyHostPeerIdFromMeetings(peerIdOverride) {
    const peerIn = document.getElementById("peerIdIn");
    const partnerId = getSelectedPartnerUserId();
    const waiting = state.meetings.find((m) => {
      if (m.isHost) return false;
      if (m.status !== "live") return false;
      if (!String(m.hostPeerId || "").trim() && !peerIdOverride) return false;
      if (partnerId) {
        const hostId = m.host?.id;
        if (hostId && hostId !== partnerId) return false;
      }
      return true;
    });
    const peerId = peerIdOverride || waiting?.hostPeerId;
    if (peerIn instanceof HTMLInputElement && peerId && peerIn.value.trim() !== peerId) {
      peerIn.value = peerId;
      peerIn.placeholder = "Session ID (auto-filled) …";
      peerIn.dispatchEvent(new Event("input", { bubbles: true }));
      const guestStatus = document.getElementById("statusGuest");
      if (guestStatus && !global.appSessionRole?.()) {
        guestStatus.textContent = "Session ID ready — click Share Cam.";
        guestStatus.className = "status-line ok";
      }
    }
    updateSessionActionHighlight();
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
        const statusLabel =
          m.mode === "instant" && m.status === "live"
            ? "Instant Live"
            : m.status === "live" && !String(m.hostPeerId || "").trim()
              ? "live · ready to resume"
              : m.status;
        body.innerHTML =
          `<strong>${m.mode === "instant" ? "Instant" : "Scheduled"}</strong> · ${statusLabel}` +
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
        const actions = document.createElement("div");
        actions.className = "meeting-list-item-actions";
        const inCall = global.appSessionRole?.();
        const showJoin =
          !m.isHost && m.mode === "instant" && m.status === "live" && !inCall;
        if (showJoin) {
          if (state.sessionJoinedMeetingId === m.id) {
            const joined = document.createElement("span");
            joined.className = "meeting-joined-badge";
            joined.textContent = "Joined";
            actions.appendChild(joined);
          } else {
            const joinBtn = document.createElement("button");
            joinBtn.type = "button";
            joinBtn.className = "meeting-join-btn primary";
            joinBtn.textContent = "Join";
            joinBtn.title = "Join session and open Play Mode";
            joinBtn.addEventListener("click", async (e) => {
              e.stopPropagation();
              try {
                await joinInstantMeeting(m);
              } catch (err) {
                setMeetingStatusOnAll(err.message || "Could not join session.", "err");
              }
            });
            actions.appendChild(joinBtn);
          }
        }
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
            if (state.sessionJoinedMeetingId === m.id) {
              state.sessionJoinedMeetingId = null;
              global.MemberProfile?.setPartnerProfile?.(null);
            }
            setMeetingStatusOnAll("Session removed for both sides.", "ok");
          } catch (err) {
            setMeetingStatusOnAll(err.message || "Could not remove session.", "err");
          }
        });
        actions.appendChild(delBtn);
        row.appendChild(actions);
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

  function findResumableHostMeeting() {
    const partnerId = getSelectedPartnerUserId();
    return (
      state.meetings.find((m) => {
        if (!m.isHost) return false;
        if (m.mode !== "instant") return false;
        if (m.status !== "live" && m.status !== "completed") return false;
        if (partnerId && m.guest?.id !== partnerId) return false;
        return true;
      }) || null
    );
  }

  function getActiveLiveMeetingId() {
    if (state._pendingMeetingId) return state._pendingMeetingId;
    const instant = findResumableHostMeeting();
    if (instant?.id) return instant.id;
    const partnerId = getSelectedPartnerUserId();
    const fallback = state.meetings.find((m) => {
      if (!m.isHost || m.status !== "live") return false;
      if (partnerId && m.guest?.id !== partnerId) return false;
      return true;
    });
    return fallback?.id || null;
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
      block.querySelector(".js-invite-by-email")?.addEventListener("click", () => {
        if (global.DualPeerAuth?.openInviteModal) {
          global.DualPeerAuth.openInviteModal();
        } else {
          global.dispatchEvent(new CustomEvent("dualpeer-open-invite"));
        }
      });

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
                  : "Instant session — click Join next to Instant Live, then Share Cam when ready.",
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
      setContactPool([]);
      renderActiveMembersPanel();
      return;
    }
    try {
      const data = await api("/api/social/model-pool");
      state.modelPool = data.models || [];
      setContactPool([...state.contactPool, ...state.modelPool]);
    } catch (err) {
      console.warn("[social] model pool failed:", err);
    }
  }

  function renderContactPoolPanel() {
    const root = document.getElementById("modelPoolList");
    const status = document.getElementById("modelPoolStatus");
    if (!root) return;
    root.replaceChildren();
    if (!state.contactPool.length) {
      if (status) {
        status.className = "status-line";
        status.textContent =
          "No contacts yet — invite someone or complete a session to build your pool.";
      }
      return;
    }
    if (status) {
      status.className = "status-line ok";
      status.textContent = `${state.contactPool.length} contact${state.contactPool.length === 1 ? "" : "s"} · double-click to add`;
    }
    for (const m of state.contactPool) {
      root.appendChild(
        buildMemberCard(m, {
          variant: "pool",
          onActivate: (contact) => {
            if (addActiveMember(contact)) {
              const st = document.getElementById("setupActiveMembersStatus");
              if (st) {
                st.hidden = false;
                st.className = "status-line ok";
                st.textContent = `${contact.displayName} added to Members.`;
              }
            }
          },
        })
      );
    }
  }

  function renderActiveMembersPanel() {
    const root = document.getElementById("setupModelPoolList");
    const status = document.getElementById("setupModelPoolStatus");
    if (!root) return;
    root.replaceChildren();
    if (!state.activeMembers.length) {
      if (status) {
        status.className = "status-line";
        status.textContent = "No members selected — double-click someone in Member Pool (right).";
      }
      return;
    }
    if (status) {
      status.className = "status-line ok";
      status.textContent = `${state.activeMembers.length} member${state.activeMembers.length === 1 ? "" : "s"} for this session.`;
    }
    for (const m of state.activeMembers) {
      const poolEntry = state.contactPool.find((c) => c.id === m.id);
      const merged = poolEntry ? { ...m, signedIn: poolEntry.signedIn } : m;
      root.appendChild(
        buildMemberCard(merged, {
          variant: "active",
          selected: merged.id === state.sessionPartnerId,
          onSelect: (member) => coupleSessionWithPartner(member.id, { addToMembers: false }),
          onRemove: (id) => removeActiveMember(id),
        })
      );
    }
  }

  async function refreshMembersWorkspace() {
    clearActiveMembers({ clearStorage: true, clearChat: true });
    state.threadId = null;
    state.partner = null;
    await bootstrap({ loadChat: false });
    const st = document.getElementById("setupActiveMembersStatus");
    if (st) {
      st.hidden = false;
      st.className = "status-line ok";
      st.textContent = "Members cleared — pick from Member Pool (right).";
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

  async function pauseActiveSession() {
    await api("/api/social/session/pause", { method: "POST" });
    await bootstrap({ loadChat: false });
    applyHostPeerIdFromMeetings();
    updateSessionActionHighlight();
  }

  async function clearAllSessions() {
    await api("/api/social/sessions/clear", { method: "POST" });
    state.meetings = state.meetings.filter(
      (m) => m.status === "scheduled" || (m.mode === "scheduled" && m.status !== "completed")
    );
    state._pendingMeetingId = null;
    updateMeetingPanels();
    applyHostPeerIdFromMeetings();
    updateSessionActionHighlight();
    broadcastMeetingsChanged();
  }

  async function endLiveSession() {
    return pauseActiveSession();
  }

  function fillPartnerSelects(threads = []) {
    const partners = [];
    for (const m of state.contactPool || []) {
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
      if (!sel.dataset.partnerHighlightBound) {
        sel.dataset.partnerHighlightBound = "1";
        sel.addEventListener("change", () => {
          if (couplingPartner) return;
          const partnerId = sel.value?.trim() || "";
          if (!partnerId) {
            coupleSessionWithPartner(null, { addToMembers: false });
            return;
          }
          coupleSessionWithPartner(partnerId, { addToMembers: true });
        });
      }
      sel.replaceChildren();
      if (!partners.length) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "No contact yet — complete registration or get invited";
        sel.appendChild(opt);
        return;
      }
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose session partner…";
      sel.appendChild(placeholder);
      for (const p of partners) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = `${p.displayName} (@${p.username}) · Model`;
        sel.appendChild(opt);
      }
      const coupledId = getCoupledPartnerId();
      if (coupledId && [...sel.options].some((o) => o.value === coupledId)) {
        couplingPartner = true;
        sel.value = coupledId;
        couplingPartner = false;
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
      const uid = getSessionUserId();
      if (state.activeUserId && uid && state.activeUserId !== uid) {
        resetSocialClientState({ broadcast: true });
      }
      state.activeUserId = uid;
      bootstrap();
      startMeetingsPolling();
      startPresenceHeartbeat();
    } else {
      const prevUid = state.activeUserId;
      state.activeUserId = null;
      resetSocialClientState({ broadcast: true, userId: prevUid });
      stopMeetingsPolling();
      stopPresenceHeartbeat();
    }
  }

  function initMembersToolbar() {
    document.getElementById("btnClearActiveMembers")?.addEventListener("click", () => {
      clearActiveMembers({ clearStorage: true, clearChat: true });
      const st = document.getElementById("setupActiveMembersStatus");
      if (st) {
        st.hidden = false;
        st.className = "status-line ok";
        st.textContent = "Members and chat cleared — pick from Member Pool (right).";
      }
    });
  }

  function initLiveChatToolbar() {
    document.getElementById("btnClearLiveChat")?.addEventListener("click", async () => {
      try {
        await clearLiveChat({ deleteServer: true });
        setChatClearStatus("Chat cleared.");
      } catch (err) {
        setChatClearStatus(err?.message || "Could not clear chat.", "err");
      }
    });
  }

  function init() {
    listenBroadcast();
    mountMeetingBlocks();
    initMeetingBlocks();
    initAddToModelPool();
    initMembersToolbar();
    initLiveChatToolbar();
    initHeaderChatSend();
    handleCalendarRedirect();

    global.addEventListener("dualpeer-auth-change", () => refreshAuthUi());
    global.addEventListener("dualpeer-session-role", () => updateSessionActionHighlight());
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
    clearLiveChat,
    resetSocialClientState,
    publishHostPeerId,
    getActiveLiveMeetingId,
    resolveLiveMeetingId,
    applyHostPeerIdFromMeetings,
    updateSessionActionHighlight,
    joinInstantMeeting,
    loadPartnerPlaybook,
    onPartnerDisconnected,
    isSessionJoined,
    ensureChatThread,
    loadModelPool,
    addModelToPool,
    checkConnectAvailable,
    endLiveSession,
    pauseActiveSession,
    clearAllSessions,
    getModelPool: () => state.modelPool,
    getContactPool: () => state.contactPool,
    getActiveMembers: () => state.activeMembers,
    addActiveMember,
    refreshMembersWorkspace,
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
    appendTechniqueMessage(senderName, label, isLocal, ts) {
      const uid = getSessionUserId();
      const at = ts || Date.now();
      const name = String(senderName || "Partner").trim();
      const action = String(label || "").trim();
      if (!action) return;
      const body = isLocal ? `You request: ${action}` : `${name} requests: ${action}`;
      const id = `technique-${at}-${Math.random().toString(36).slice(2, 9)}`;
      if (state.messages.some((m) => m.id === id)) return;
      setMessages(
        mergeMessages(state.messages, [
          {
            id,
            senderUserId: isLocal ? uid : null,
            senderName: isLocal ? "You" : name,
            body,
            kind: "technique",
            createdAt: at,
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
