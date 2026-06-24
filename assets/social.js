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
  let lastPartnerPlaybookPartnerId = null;
  let lastPartnerPlaybookFingerprint = "";

  const state = {
    threadId: null,
    threads: [],
    partner: null,
    inviteHost: null,
    meetings: [],
    modelPool: [],
    premiumPartners: [],
    contactPool: [],
    activeMembers: [],
    sessionPartnerId: null,
    messages: [],
    loaded: false,
    calendar: { configured: false, connected: false, email: "" },
    renderFingerprint: null,
    threadLastMessageAt: null,
    activeUserId: null,
    sessionJoinedMeetingId: null,
    expandedPoolMemberId: null,
    contactPoolRenderKey: "",
    poolProfileCache: {},
    sessionBookings: [],
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

  function singleSessionPartnerFromList(list) {
    const normalized = (list || []).map(normalizeContact).filter(Boolean);
    if (!normalized.length) return null;
    if (normalized.length === 1) return normalized[0];
    return (
      (state.sessionPartnerId && normalized.find((m) => m.id === state.sessionPartnerId)) ||
      normalized[normalized.length - 1] ||
      normalized[0]
    );
  }

  function saveActiveMembersToStorage(list) {
    const uid = getSessionUserId();
    if (!uid) return;
    try {
      const partner = singleSessionPartnerFromList(list);
      const all = JSON.parse(localStorage.getItem(ACTIVE_MEMBERS_KEY) || "{}");
      all[uid] = partner ? [partner] : [];
      localStorage.setItem(ACTIVE_MEMBERS_KEY, JSON.stringify(all));
    } catch (_) {
      /* ignore */
    }
  }

  function applyActiveMembersFromServer(list) {
    const partner = singleSessionPartnerFromList(list);
    state.activeMembers = partner ? [partner] : [];
    saveActiveMembersToStorage(state.activeMembers);
    if (!state.activeMembers.length) {
      state.sessionPartnerId = null;
      saveSessionPartnerIdToStorage(null);
    } else if (state.sessionPartnerId && !state.activeMembers.some((m) => m.id === state.sessionPartnerId)) {
      state.sessionPartnerId = null;
      saveSessionPartnerIdToStorage(null);
    }
    renderActiveMembersPanel();
  }

  async function syncSessionMemberReplace(memberUserId) {
    const id = String(memberUserId || "").trim();
    if (!id || !isLoggedIn()) return false;
    const data = await api("/api/social/session-members", {
      method: "POST",
      body: JSON.stringify({ memberUserId: id, replace: true }),
    });
    applyActiveMembersFromServer(data.activeMembers);
    return true;
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

  function findActiveInstantSessionWithPartner(partnerId) {
    const id = String(partnerId || getCoupledPartnerId() || "").trim();
    const uid = getSessionUserId();
    if (!id || !uid) return null;
    return (
      state.meetings.find((m) => {
        if (m.mode !== "instant" || m.status !== "live") return false;
        const hostId = m.host?.id;
        const guestId = m.guest?.id;
        if (!hostId || !guestId) return false;
        const involvesUs = hostId === uid || guestId === uid;
        const involvesPartner = hostId === id || guestId === id;
        return involvesUs && involvesPartner;
      }) || null
    );
  }

  function clearPartnerPlaybookState() {
    state.sessionJoinedMeetingId = null;
    resetPartnerPlaybookCache();
    global.MemberProfile?.setPartnerProfile?.(null);
  }

  function coupleSessionWithPartner(partnerId, { addToMembers = true } = {}) {
    const id = String(partnerId || "").trim();
    const previousId = state.sessionPartnerId;
    if (!id) {
      state.sessionPartnerId = null;
      saveSessionPartnerIdToStorage(null);
      clearPartnerPlaybookState();
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

    const hasOnlyThisPartner =
      state.activeMembers.length === 1 && state.activeMembers[0]?.id === id;
    if (!hasOnlyThisPartner) {
      if (isLoggedIn()) {
        syncSessionMemberReplace(id).catch((err) => {
          console.warn("[social] session member sync failed:", err);
        });
      } else {
        const contact =
          state.contactPool.find((c) => c.id === id) ||
          state.threads.find((t) => t.partner?.id === id)?.partner;
        if (contact) {
          state.activeMembers = [normalizeContact(contact)];
          saveActiveMembersToStorage(state.activeMembers);
        }
      }
    }

    if (previousId && previousId !== id) {
      clearLiveChat({ deleteServer: true }).catch(() => {});
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
    if (id && isLoggedIn()) {
      resetPartnerPlaybookCache();
      loadPartnerPlaybook(id, { force: true }).catch(() => {});
    }
  }

  function partnerPlaybookFingerprint(profile) {
    if (!profile || typeof profile !== "object") return "";
    return JSON.stringify({
      displayName: profile.displayName || "",
      gender: profile.gender || "",
      bio: profile.bio || "",
      techniques: Array.isArray(profile.techniques) ? profile.techniques : [],
      customTechniques: Array.isArray(profile.customTechniques) ? profile.customTechniques : [],
      customMenus: Array.isArray(profile.customMenus) ? profile.customMenus : [],
      enabledCustomMenus: Array.isArray(profile.enabledCustomMenus) ? profile.enabledCustomMenus : [],
      playPrefs: profile.playPrefs || null,
    });
  }

  function resetPartnerPlaybookCache() {
    lastPartnerPlaybookPartnerId = null;
    lastPartnerPlaybookFingerprint = "";
  }

  function resolvePartnerIdForPlaybookRefresh() {
    const selected = getSelectedPartnerUserId();
    if (selected) return selected;
    if (state.sessionJoinedMeetingId) {
      const meeting = state.meetings.find((m) => m.id === state.sessionJoinedMeetingId);
      if (meeting) return meeting.isHost ? meeting.guest?.id : meeting.host?.id;
    }
    return null;
  }

  function shouldRefreshPartnerPlaybook() {
    const partnerId = resolvePartnerIdForPlaybookRefresh();
    if (!partnerId) return false;
    if (state.sessionJoinedMeetingId) return true;
    if (global.appSessionRole?.()) return true;
    if (global.MemberProfile?.getPartnerProfile?.()) return true;
    if (state.activeMembers.some((m) => m.id === partnerId)) return true;
    return false;
  }

  async function refreshPartnerPlaybookIfNeeded() {
    const partnerId = resolvePartnerIdForPlaybookRefresh();
    if (!partnerId || !isLoggedIn() || !shouldRefreshPartnerPlaybook()) return null;
    return loadPartnerPlaybook(partnerId);
  }

  function normalizeContact(raw) {
    if (!raw?.id) return null;
    return {
      id: raw.id,
      username: raw.username,
      displayName: raw.displayName || raw.username || "Member",
      avatarUrl: raw.avatarUrl || null,
      signedIn: Boolean(raw.signedIn || raw.online),
      isModel: Boolean(raw.isModel || raw.isPremiumPartner),
      isPremiumPartner: Boolean(raw.isPremiumPartner || raw.isModel),
    };
  }

  function canAccessPremiumPartners() {
    const auth = global.DualPeerAuth;
    if (!auth?.isLoggedIn?.()) return false;
    const user = auth.getSession?.()?.user;
    return Boolean(auth.hasPremiumModelAccess?.(user));
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

  async function addActiveMember(raw) {
    const contact = normalizeContact(raw);
    if (!contact) return false;
    const previousId = state.sessionPartnerId;
    const isSwitch = previousId && previousId !== contact.id;
    try {
      if (isSwitch) {
        await clearLiveChat({ deleteServer: true });
      }
      if (isLoggedIn()) {
        await syncSessionMemberReplace(contact.id);
      } else {
        state.activeMembers = [contact];
        saveActiveMembersToStorage(state.activeMembers);
      }
      coupleSessionWithPartner(contact.id, { addToMembers: false });
      await selectPartnerById(contact.id);
      return true;
    } catch (err) {
      console.warn("[social] add active member failed:", err);
      return false;
    }
  }

  async function removeActiveMember(memberId) {
    const id = String(memberId || "").trim();
    if (!id) return;
    try {
      if (isLoggedIn()) {
        const data = await api(`/api/social/session-members/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        applyActiveMembersFromServer(data.activeMembers);
      } else {
        state.activeMembers = state.activeMembers.filter((m) => m.id !== id);
        saveActiveMembersToStorage(state.activeMembers);
        renderActiveMembersPanel();
      }
      if (state.sessionPartnerId === id) {
        coupleSessionWithPartner(state.activeMembers[0]?.id || null, { addToMembers: false });
      }
      clearLiveChat({ deleteServer: true }).catch(() => {});
    } catch (err) {
      console.warn("[social] remove active member failed:", err);
    }
  }

  async function clearActiveMembers({ clearStorage = true, clearChat = true } = {}) {
    try {
      if (isLoggedIn()) {
        await api("/api/social/session-members", { method: "DELETE" });
      }
    } catch (err) {
      console.warn("[social] clear session members failed:", err);
    }
    state.activeMembers = [];
    state.sessionPartnerId = null;
    clearPartnerPlaybookState();
    if (clearStorage) clearActiveMembersStorage();
    else saveSessionPartnerIdToStorage(null);
    renderActiveMembersPanel();
    couplingPartner = true;
    document.querySelectorAll(".js-meeting-partner-select").forEach((sel) => {
      if (sel instanceof HTMLSelectElement) sel.value = "";
    });
    couplingPartner = false;
    if (clearChat) {
      try {
        await clearLiveChat({ deleteServer: true });
      } catch (err) {
        console.warn("[social] clear chat failed:", err);
      }
    }
    state.partner = null;
    state.threadId = null;
    renderMessages({ skipBroadcast: true });
    updateSessionActionHighlight();
    updatePartnerInstantRow();
  }

  function applyPartnerChatColors(partner) {
    const colors = partner?.chatColors;
    if (colors && global.DualPeerChatUi?.setPartnerSharedColors) {
      global.DualPeerChatUi.setPartnerSharedColors(colors);
    }
  }

  function applyPartnerPlayModeSound(partner) {
    const id = partner?.playModeSound;
    if (id && global.DualPeerPlayModeSounds?.setPartnerSoundId) {
      global.DualPeerPlayModeSounds.setPartnerSoundId(id);
    }
  }

  async function selectPartnerById(partnerId) {
    const id = String(partnerId || "").trim();
    if (!id) return;
    const thread = state.threads.find((t) => t.partner?.id === id);
    if (thread?.id) {
      state.partner = thread.partner;
      state.threadId = thread.id;
      applyPartnerChatColors(thread.partner);
      applyPartnerPlayModeSound(thread.partner);
      await loadThreadMessages(thread.id);
      return;
    }
    state.partner = state.contactPool.find((c) => c.id === id) || null;
  }

  const POOL_GENDER_LABELS = {
    female: "Female",
    male: "Male",
    nonbinary: "Non-binary",
    other: "Other",
  };
  const POOL_BODY_LABELS = {
    slim: "Slim",
    athletic: "Athletic",
    average: "Average",
    curvy: "Curvy",
    plus: "Plus size",
    muscular: "Muscular",
  };
  const POOL_INTEREST_LABELS = {
    women: "Women",
    men: "Men",
    nonbinary: "Non-binary people",
    everyone: "Everyone",
  };

  function poolPrefLabels(ids, group) {
    const PP = global.DualPeerPlayPrefs;
    if (!PP || !Array.isArray(ids) || !ids.length) return "";
    const list =
      group === "dynamics" ? PP.DYNAMICS : group === "kinks" ? PP.KINKS : PP.INTENSITY;
    const map = new Map((list || []).map((o) => [o.id, o.label]));
    return ids.map((id) => map.get(id) || id).join(", ");
  }

  function poolCardRenderToken(m) {
    if (!m?.id) return "";
    const live = findActiveInstantSessionWithPartner(m.id) ? 1 : 0;
    return `${m.id}:${m.signedIn ? 1 : 0}:${live}:${m.isPremiumPartner ? 1 : 0}`;
  }

  function contactPoolRenderKey(regularContacts, premiumContacts, showPremium) {
    const regular = (regularContacts || []).map(poolCardRenderToken).join("|");
    const premium = showPremium ? (premiumContacts || []).map(poolCardRenderToken).join("|") : "";
    return `${regular}::${premium}`;
  }

  function findPoolEntryByMemberId(memberId) {
    const id = String(memberId || "").trim();
    if (!id) return null;
    const sel = `.model-pool-entry[data-member-id="${CSS.escape(id)}"]`;
    return (
      document.querySelector(`#modelPoolList ${sel}`) ||
      document.querySelector(`#premiumPartnersList ${sel}`)
    );
  }

  function restoreExpandedPoolMemberPreview() {
    const memberId = state.expandedPoolMemberId;
    if (!memberId) return;
    const entry = findPoolEntryByMemberId(memberId);
    if (!entry) {
      state.expandedPoolMemberId = null;
      return;
    }
    const detail = entry.querySelector(".model-pool-detail");
    if (!detail) return;

    entry.classList.add("is-expanded");
    detail.hidden = false;

    const cached = state.poolProfileCache[memberId];
    if (cached) {
      renderPoolMemberDetail(detail, cached, findPoolMemberMeta(memberId));
      return;
    }

    detail.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "status-line";
    loading.textContent = "Loading profile…";
    detail.appendChild(loading);

    void fetchPoolMemberProfile(memberId)
      .then((profile) => {
        if (state.expandedPoolMemberId !== memberId) return;
        if (profile) state.poolProfileCache[memberId] = profile;
        renderPoolMemberDetail(detail, profile, findPoolMemberMeta(memberId));
      })
      .catch((err) => {
        if (state.expandedPoolMemberId !== memberId) return;
        detail.replaceChildren();
        const errEl = document.createElement("p");
        errEl.className = "status-line err";
        errEl.textContent = err.message || "Could not load profile.";
        detail.appendChild(errEl);
      });
  }

  function findPoolMemberMeta(memberId) {
    if (!memberId) return null;
    return (
      state.contactPool.find((c) => c.id === memberId) ||
      state.premiumPartners.find((c) => c.id === memberId) ||
      state.modelPool.find((c) => c.id === memberId) ||
      null
    );
  }

  function formatBookingAmount(minor, currency = "EUR") {
    const eur = (Number(minor || 0) / 100).toFixed(2);
    return currency === "EUR" ? `${eur} €` : `${eur} ${currency}`;
  }

  function formatBookingWhen(startAt, endAt) {
    if (!startAt) return "—";
    const start = new Date(startAt);
    const end = endAt ? new Date(endAt) : null;
    const dateOpts = { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
    const startStr = start.toLocaleString(undefined, dateOpts);
    if (!end) return startStr;
    const endStr = end.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return `${startStr} – ${endStr}`;
  }

  function bookingStatusLabel(booking) {
    if (booking.status === "rejected") return "Declined";
    if (booking.status === "completed") return "Completed";
    if (booking.escrowStatus === "released") return "Paid out";
    if (booking.escrowStatus === "funded") return "Paid — session scheduled";
    if (booking.status === "accepted") return "Accepted — awaiting payment";
    if (booking.status === "pending") return "Awaiting partner";
    return booking.status || "—";
  }

  async function loadSessionBookings() {
    const section = document.getElementById("sessionBookingsSection");
    if (!isLoggedIn()) {
      state.sessionBookings = [];
      if (section) section.hidden = true;
      return;
    }
    if (section) section.hidden = false;
    try {
      const data = await global.DualPeerAuth?.fetchMyBookings?.();
      state.sessionBookings = data?.bookings || [];
    } catch (err) {
      console.warn("[social] session bookings failed:", err);
      state.sessionBookings = [];
    }
    renderSessionBookings();
  }

  function renderSessionBookings() {
    const root = document.getElementById("sessionBookingsList");
    const status = document.getElementById("sessionBookingsStatus");
    if (!root) return;

    const bookings = state.sessionBookings || [];
    root.replaceChildren();

    if (!bookings.length) {
      if (status) {
        status.hidden = false;
        status.className = "status-line";
        status.textContent = canAccessPremiumPartners()
          ? "No session requests yet — open a Premium Partner profile and tap Request paid session."
          : "No session requests yet.";
      }
      return;
    }

    if (status) status.hidden = true;

    for (const booking of bookings) {
      const card = document.createElement("article");
      card.className = "session-booking-card";
      card.dataset.bookingId = booking.id;

      const head = document.createElement("div");
      head.className = "session-booking-head";
      const title = document.createElement("strong");
      title.textContent =
        booking.role === "guest"
          ? `With ${booking.modelName || "Premium Partner"}`
          : `From ${booking.guestName || "Member"}`;
      const badge = document.createElement("span");
      badge.className = "session-booking-status";
      badge.textContent = bookingStatusLabel(booking);
      head.appendChild(title);
      head.appendChild(badge);
      card.appendChild(head);

      const meta = document.createElement("p");
      meta.className = "status-line session-booking-meta";
      meta.textContent = `${formatBookingWhen(booking.scheduledStartAt, booking.scheduledEndAt)} · ${formatBookingAmount(booking.totalAmountMinor, booking.currency)}`;
      card.appendChild(meta);

      const note = String(booking.guestNote || "").trim();
      if (note) {
        const noteEl = document.createElement("p");
        noteEl.className = "status-line session-booking-note";
        noteEl.textContent = `“${note}”`;
        card.appendChild(noteEl);
      }

      const actions = document.createElement("div");
      actions.className = "session-booking-actions";

      if (booking.role === "model" && booking.status === "pending" && booking.escrowStatus === "not_funded") {
        const acceptBtn = document.createElement("button");
        acceptBtn.type = "button";
        acceptBtn.className = "primary";
        acceptBtn.textContent = "Accept";
        acceptBtn.addEventListener("click", () => void handleBookingAccept(booking.id, acceptBtn));
        actions.appendChild(acceptBtn);

        const rejectBtn = document.createElement("button");
        rejectBtn.type = "button";
        rejectBtn.className = "secondary";
        rejectBtn.textContent = "Decline";
        rejectBtn.addEventListener("click", () => void handleBookingReject(booking.id, rejectBtn));
        actions.appendChild(rejectBtn);
      }

      if (
        booking.role === "guest" &&
        booking.status === "accepted" &&
        booking.escrowStatus === "not_funded"
      ) {
        const payBtn = document.createElement("button");
        payBtn.type = "button";
        payBtn.className = "primary";
        payBtn.textContent = "Pay now (escrow)";
        payBtn.addEventListener("click", () => void handleBookingPay(booking.id, payBtn));
        actions.appendChild(payBtn);
      }

      if (booking.escrowStatus === "funded" && ["accepted", "in_progress"].includes(booking.status)) {
        const completeBtn = document.createElement("button");
        completeBtn.type = "button";
        completeBtn.className = "secondary";
        completeBtn.textContent = "Mark session complete";
        completeBtn.addEventListener("click", () => void handleBookingComplete(booking.id, completeBtn));
        actions.appendChild(completeBtn);
      }

      if (actions.childElementCount) card.appendChild(actions);
      root.appendChild(card);
    }
  }

  async function handleBookingAccept(bookingId, btn) {
    if (btn) btn.disabled = true;
    try {
      await global.DualPeerAuth.acceptModelBooking(bookingId);
      await loadSessionBookings();
    } catch (err) {
      alert(err.message || "Could not accept request.");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function handleBookingReject(bookingId, btn) {
    const reason = window.prompt("Optional message for the guest:") || "";
    if (btn) btn.disabled = true;
    try {
      await global.DualPeerAuth.rejectModelBooking(bookingId, reason);
      await loadSessionBookings();
    } catch (err) {
      alert(err.message || "Could not decline request.");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function handleBookingPay(bookingId, btn) {
    if (btn) btn.disabled = true;
    try {
      const checkout = await global.DualPeerAuth.fundModelBooking(bookingId);
      if (checkout?.url) {
        window.location.href = checkout.url;
        return;
      }
      throw new Error("Checkout URL missing.");
    } catch (err) {
      alert(err.message || "Payment could not be started.");
      if (btn) btn.disabled = false;
    }
  }

  async function handleBookingComplete(bookingId, btn) {
    if (!window.confirm("Release escrow payout to the Premium Partner?")) return;
    if (btn) btn.disabled = true;
    try {
      await global.DualPeerAuth.completeModelBooking(bookingId);
      await loadSessionBookings();
    } catch (err) {
      alert(err.message || "Could not complete session.");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function fetchPoolMemberProfile(memberId) {
    const data = await api(`/api/social/model-pool/${encodeURIComponent(memberId)}/profile`);
    return data.profile || null;
  }

  function renderPoolMemberDetail(container, profile, memberMeta) {
    if (!container || !profile) return;
    container.replaceChildren();

    const title = document.createElement("h4");
    title.className = "model-pool-detail-title";
    title.textContent = "About me";
    container.appendChild(title);

    const isPremiumPartner =
      Boolean(memberMeta?.isPremiumPartner || memberMeta?.isModel) && canAccessPremiumPartners();

    if (isPremiumPartner) {
      const rateBlock = document.createElement("div");
      rateBlock.className = "model-pool-detail-rate";
      const rateLabel = document.createElement("strong");
      rateLabel.textContent = "Session rate";
      const rateText = document.createElement("p");
      rateText.className = "status-line";
      if (memberMeta?.hourlyRateMinor) {
        rateText.textContent = `${formatBookingAmount(memberMeta.hourlyRateMinor).replace(" €", "")} € / hour`;
      } else {
        rateText.textContent = "Rate on request — propose an amount when you send a session request.";
      }
      rateBlock.appendChild(rateLabel);
      rateBlock.appendChild(rateText);
      container.appendChild(rateBlock);

      const bookWrap = document.createElement("div");
      bookWrap.className = "model-pool-detail-book";
      const bookBtn = document.createElement("button");
      bookBtn.type = "button";
      bookBtn.className = "primary model-pool-detail-book-btn";
      bookBtn.textContent = "Request paid session";
      bookBtn.title = "Propose amount and time — partner accepts before you pay";
      bookBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        global.DualPeerModelBooking?.open?.(memberMeta);
      });
      bookWrap.appendChild(bookBtn);
      container.appendChild(bookWrap);
    }

    const dl = document.createElement("dl");
    dl.className = "model-pool-detail-dl";

    const addRow = (label, value) => {
      if (!value || value === "—") return;
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      dl.appendChild(dt);
      dl.appendChild(dd);
    };

    addRow("Age", profile.age ? String(profile.age) : "");
    addRow("Gender", POOL_GENDER_LABELS[profile.gender] || profile.gender);
    addRow("Body type", POOL_BODY_LABELS[profile.bodyType] || profile.bodyType);
    addRow("Interested in", POOL_INTEREST_LABELS[profile.interestedIn] || profile.interestedIn);
    addRow("Nationality", profile.nationality);
    addRow("Languages", profile.languages);
    addRow("Location", profile.location);
    addRow("Dynamics", poolPrefLabels(profile.playPrefs?.dynamics, "dynamics"));
    addRow("Kinks & practices", poolPrefLabels(profile.playPrefs?.kinks, "kinks"));
    addRow("Intensity", poolPrefLabels(profile.playPrefs?.intensity, "intensity"));

    if (dl.childElementCount) container.appendChild(dl);

    const bio = String(profile.bio || "").trim();
    if (bio) {
      const bioBlock = document.createElement("div");
      bioBlock.className = "model-pool-detail-bio";
      const bioLabel = document.createElement("strong");
      bioLabel.textContent = "Bio";
      const bioText = document.createElement("p");
      bioText.textContent = bio;
      bioBlock.appendChild(bioLabel);
      bioBlock.appendChild(bioText);
      container.appendChild(bioBlock);
    }

    const gallery = Array.isArray(profile.galleryImages) ? profile.galleryImages : [];
    if (gallery.length) {
      const galleryWrap = document.createElement("div");
      galleryWrap.className = "model-pool-detail-gallery";
      const galleryLabel = document.createElement("strong");
      galleryLabel.textContent = "Photos";
      galleryWrap.appendChild(galleryLabel);
      const grid = document.createElement("div");
      grid.className = "model-pool-gallery-grid";
      const urls = [];
      for (const img of gallery) {
        if (!img?.url) continue;
        let src = "";
        try {
          src = new URL(String(img.url), location.origin).href;
        } catch (_) {
          src = global.DualPeerAuth?.resolveAssetUrl?.(img.url) || img.url;
        }
        urls.push(src);
      }
      urls.forEach((src, i) => {
        const el = document.createElement("img");
        el.className = "model-pool-gallery-thumb";
        el.loading = "lazy";
        el.alt = "";
        el.src = src;
        el.addEventListener("click", () => {
          global.DualPeerGalleryLightbox?.open?.({ images: urls, startIndex: i });
        });
        grid.appendChild(el);
      });
      galleryWrap.appendChild(grid);
      container.appendChild(galleryWrap);
    }

    if (!bio && !dl.childElementCount && !gallery.length) {
      const empty = document.createElement("p");
      empty.className = "status-line";
      empty.textContent = "No profile details yet.";
      container.appendChild(empty);
    }
  }

  async function togglePoolMemberPreview(memberId, entry) {
    const detail = entry?.querySelector?.(".model-pool-detail");
    if (!detail) return;

    if (state.expandedPoolMemberId === memberId) {
      state.expandedPoolMemberId = null;
      entry.classList.remove("is-expanded");
      detail.hidden = true;
      return;
    }

    document.querySelectorAll(".model-pool-entry.is-expanded").forEach((el) => {
      el.classList.remove("is-expanded");
      const panel = el.querySelector(".model-pool-detail");
      if (panel) panel.hidden = true;
    });

    state.expandedPoolMemberId = memberId;
    entry.classList.add("is-expanded");
    detail.hidden = false;
    detail.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "status-line";
    loading.textContent = "Loading profile…";
    detail.appendChild(loading);

    try {
      const profile = await fetchPoolMemberProfile(memberId);
      if (state.expandedPoolMemberId !== memberId) return;
      if (profile) state.poolProfileCache[memberId] = profile;
      renderPoolMemberDetail(detail, profile, findPoolMemberMeta(memberId));
    } catch (err) {
      detail.replaceChildren();
      const errEl = document.createElement("p");
      errEl.className = "status-line err";
      errEl.textContent = err.message || "Could not load profile.";
      detail.appendChild(errEl);
    }
  }

  function buildPoolEntry(m, cardOptions) {
    const entry = document.createElement("div");
    entry.className = "model-pool-entry";
    entry.dataset.memberId = m.id;

    const card = buildMemberCard(m, {
      ...cardOptions,
      onPreview: () => {
        void togglePoolMemberPreview(m.id, entry);
      },
    });
    entry.appendChild(card);

    const detail = document.createElement("div");
    detail.className = "model-pool-detail";
    detail.hidden = true;
    entry.appendChild(detail);

    return entry;
  }

  function buildMemberCard(m, { variant, onRemove, onActivate, onPreview, onSelect, selected, premiumPartner } = {}) {
    const sessionLive = Boolean(findActiveInstantSessionWithPartner(m.id));
    const card = document.createElement("div");
    card.className = "model-card" + (m.signedIn ? " is-signed-in" : "") + (sessionLive ? " is-session-live" : "");
    if (variant === "pool") {
      card.classList.add("model-card--pool");
      card.title = "Click for profile · double-click for Current Chat Partner";
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
    const nameRow = document.createElement("div");
    nameRow.className = "model-card-name-row";
    const name = document.createElement("strong");
    name.textContent = m.displayName || m.username || "Member";
    nameRow.appendChild(name);
    if (sessionLive) {
      const liveBadge = document.createElement("span");
      liveBadge.className = "model-live-session-badge";
      liveBadge.textContent = "Live";
      liveBadge.title = "Instant session active";
      nameRow.appendChild(liveBadge);
    }
    if (premiumPartner || m.isPremiumPartner) {
      const partnerBadge = document.createElement("span");
      partnerBadge.className = "model-premium-partner-badge";
      partnerBadge.textContent = "Premium Partner";
      nameRow.appendChild(partnerBadge);
    }
    head.appendChild(nameRow);
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
      removeBtn.title = "Remove partner for this session";
      removeBtn.setAttribute("aria-label", `Remove ${name.textContent}`);
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onRemove(m.id);
      });
      head.appendChild(removeBtn);
    }
    if (variant === "pool" && onRemove) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "model-card-remove-btn";
      removeBtn.title = "Remove from member pool";
      removeBtn.setAttribute("aria-label", `Remove ${name.textContent} from pool`);
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onRemove(m.id);
      });
      head.appendChild(removeBtn);
    }
    card.appendChild(head);

    const meta = document.createElement("span");
    if (sessionLive) {
      meta.className = "model-live-session-meta";
      meta.textContent = "Live session";
    } else {
      meta.textContent = m.signedIn ? "Online now" : "Offline";
    }
    card.appendChild(meta);

    if (premiumPartner && variant === "pool" && canAccessPremiumPartners()) {
      const bookBtn = document.createElement("button");
      bookBtn.type = "button";
      bookBtn.className = "secondary model-book-btn";
      bookBtn.textContent = "Request session";
      bookBtn.title = "Propose a paid session — partner accepts before you pay";
      bookBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        global.DualPeerModelBooking?.open?.(m);
      });
      card.appendChild(bookBtn);
    }

    if (variant === "pool") {
      let clickTimer = null;
      card.addEventListener("click", (e) => {
        if (e.target.closest(".model-card-remove-btn")) return;
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => {
          if (onPreview) onPreview(m);
        }, 260);
      });
      if (onActivate) {
        card.addEventListener("dblclick", (e) => {
          if (e.target.closest(".model-card-remove-btn")) return;
          clearTimeout(clickTimer);
          onActivate(m);
        });
      }
    }

    return card;
  }

  function maybePlayBellForNewTechniques(prev, next) {
    if (!global.playTechniqueBell || !prev?.length) return;
    const uid = getSessionUserId();
    const seen = new Set(prev.filter((m) => m.kind === "technique").map((m) => m.id));
    const fresh = next.filter(
      (m) =>
        m.kind === "technique" &&
        m.senderUserId &&
        m.senderUserId !== uid &&
        !seen.has(m.id)
    );
    if (fresh.length) {
      const m = fresh[fresh.length - 1];
      global.playTechniqueBell(global.DualPeerPlayModeSounds?.loadPartnerSoundId?.(), {
        ts: m.createdAt,
        label: m.body,
      });
    }
  }

  function setMessages(next, { skipBroadcast = false, skipBell = false } = {}) {
    const merged = sortMessages(next || []);
    const fp = messagesFingerprint(merged);
    if (fp === state.renderFingerprint) return false;
    if (!skipBell) maybePlayBellForNewTechniques(state.messages, merged);
    state.messages = merged;
    state.renderFingerprint = fp;
    syncThreadLastMessageAt(merged);
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
        const partnerId = getCoupledPartnerId();
        const partnerName = state.partner?.displayName || state.partner?.username;
        if (partnerId && partnerName) {
          empty.textContent = `Chat with ${partnerName}. History clears when the video session ends.`;
        } else if (isLoggedIn()) {
          empty.textContent = "Select a partner from the Member Pool to start chatting.";
        } else {
          empty.textContent = "Sign in and connect with your host to start chatting.";
        }
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
    if (global.DualPeerChatUi?.buildMessageElement) {
      return global.DualPeerChatUi.buildMessageElement({ uid, message: m });
    }
    const isLocal = m.senderUserId === uid;
    const msg = document.createElement("div");
    const kind =
      m.kind === "system" ? "system" : m.kind === "technique" ? (isLocal ? "local" : "remote") : isLocal ? "local" : "remote";
    msg.className = `chat-message chat-message--${kind} chat-message--compact`;
    msg.classList.add(isLocal ? "local" : "remote");
    if (kind === "system") msg.classList.add("chat-message--system");
    if (m.kind === "technique") msg.classList.add("chat-message--technique");
    const line = document.createElement("div");
    line.className = "chat-line";
    if (m.kind !== "system") {
      const meta = document.createElement("span");
      meta.className = "chat-sender";
      meta.textContent = isLocal ? "You" : m.senderName;
      line.appendChild(meta);
    }
    const textNode = document.createElement("span");
    textNode.className = "chat-text";
    textNode.textContent = m.body;
    line.appendChild(textNode);
    msg.appendChild(line);
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

  function broadcastDeleteLast(messageId) {
    try {
      const bc = getChatBroadcastChannel();
      if (!bc) return;
      bc.postMessage({
        type: "delete-last",
        threadId: state.threadId,
        messageId: messageId || null,
        sourceId: global.__dualpeerTabId,
      });
    } catch (_) {
      /* ignore */
    }
  }

  function syncThreadLastMessageAt(messages) {
    const sorted = sortMessages(messages || []);
    state.threadLastMessageAt = sorted.length ? sorted[sorted.length - 1].createdAt || null : null;
  }

  function isEphemeralMessageId(id) {
    const value = String(id || "");
    return value.startsWith("local-") || value.startsWith("technique-");
  }

  function deleteLastLocalMessage({ messageId, skipBroadcast = false } = {}) {
    if (!state.messages.length) return false;
    const sorted = sortMessages(state.messages);
    const targetId = messageId || sorted[sorted.length - 1]?.id;
    if (!targetId) return false;
    const next = state.messages.filter((m) => m.id !== targetId);
    if (next.length === state.messages.length) return false;
    state.messages = next;
    state.renderFingerprint = messagesFingerprint(next);
    syncThreadLastMessageAt(next);
    renderMessages({ skipBroadcast });
    if (!skipBroadcast) broadcastDeleteLast(targetId);
    return true;
  }

  function clearLocalChatMessages({ skipBroadcast = false } = {}) {
    state.messages = [];
    state.renderFingerprint = messagesFingerprint([]);
    state.threadLastMessageAt = null;
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

  async function deleteLastChatMessage() {
    if (!state.messages.length) {
      setChatClearStatus("No message to delete.");
      return false;
    }
    const sorted = sortMessages(state.messages);
    const last = sorted[sorted.length - 1];
    const lastId = last?.id;
    if (!lastId) {
      setChatClearStatus("No message to delete.");
      return false;
    }

    if (!isEphemeralMessageId(lastId) && state.threadId && isLoggedIn()) {
      try {
        const data = await api(
          `/api/social/chat/threads/${encodeURIComponent(state.threadId)}/messages/last`,
          { method: "DELETE" }
        );
        deleteLastLocalMessage({ messageId: data.messageId || lastId, skipBroadcast: true });
      } catch (err) {
        console.warn("[social] delete last chat failed:", err);
        setChatClearStatus(err?.message || "Could not delete last message.", "err");
        return false;
      }
    } else {
      deleteLastLocalMessage({ messageId: lastId, skipBroadcast: true });
    }

    broadcastDeleteLast(lastId);
    if (global.DualPeerChat?.relayDeleteLast) {
      global.DualPeerChat.relayDeleteLast(lastId);
    }
    setChatClearStatus("Last message deleted.");
    return true;
  }

  function applyDeleteLastMessage(messageId, { skipBroadcast = true } = {}) {
    deleteLastLocalMessage({ messageId, skipBroadcast });
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
    state.expandedPoolMemberId = null;
    state.contactPoolRenderKey = "";
    state.poolProfileCache = {};

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

    resetPartnerPlaybookCache();
    clearPartnerPlaybookState();

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
    if (data?.type === "delete-last") {
      if (data.sourceId && data.sourceId === global.__dualpeerTabId) return;
      if (data.threadId && state.threadId && data.threadId !== state.threadId) return;
      deleteLastLocalMessage({ messageId: data.messageId, skipBroadcast: true });
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

  async function loadThreadMessages(threadId, { skipBell = false } = {}) {
    if (!threadId) return;
    const data = await api(`/api/social/chat/threads/${encodeURIComponent(threadId)}/messages`);
    const serverMsgs = sortMessages(data.messages || []);
    const pending = state.messages.filter((m) => {
      if (!String(m.id).startsWith("technique-pending-")) return false;
      return !serverMsgs.some(
        (s) =>
          s.kind === "technique" &&
          s.body === m.body &&
          Math.abs((s.createdAt || 0) - (m.createdAt || 0)) < 8000
      );
    });
    state.threadId = threadId;
    state.loaded = true;
    setMessages(mergeMessages(serverMsgs, pending), { skipBroadcast: false, skipBell });
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
      const serverMembers = (data.activeMembers || []).map(normalizeContact).filter(Boolean);
      const storedMembers = loadActiveMembersFromStorage().map(normalizeContact).filter(Boolean);
      const initialMembers = serverMembers.length ? serverMembers : storedMembers;
      applyActiveMembersFromServer(initialMembers);
      if (serverMembers.length > 1 && isLoggedIn()) {
        const keepId =
          loadSessionPartnerIdFromStorage() ||
          state.sessionPartnerId ||
          serverMembers[serverMembers.length - 1]?.id;
        if (keepId) {
          await syncSessionMemberReplace(keepId);
        }
      }
      const storedPartnerId = loadSessionPartnerIdFromStorage();
      if (storedPartnerId && state.activeMembers.some((m) => m.id === storedPartnerId)) {
        state.sessionPartnerId = storedPartnerId;
        saveSessionPartnerIdToStorage(storedPartnerId);
      } else if (!state.sessionPartnerId && state.activeMembers[0]) {
        state.sessionPartnerId = state.activeMembers[0].id;
        saveSessionPartnerIdToStorage(state.sessionPartnerId);
      }

      const activeThread = pickActiveThread(threads);
      if (activeThread) {
        state.partner = activeThread.partner;
        state.threadId = activeThread.id;
        applyPartnerChatColors(activeThread.partner);
        applyPartnerPlayModeSound(activeThread.partner);
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

  function removeInstantSessionWithPartnerFromLocal(partnerId) {
    const id = String(partnerId || getCoupledPartnerId() || "").trim();
    const uid = getSessionUserId();
    if (!id || !uid) return;
    state.meetings = state.meetings.filter((m) => {
      if (m.mode !== "instant" || m.status !== "live") return true;
      const hostId = m.host?.id;
      const guestId = m.guest?.id;
      if (!hostId || !guestId) return true;
      const involvesUs = hostId === uid || guestId === uid;
      const involvesPartner = hostId === id || guestId === id;
      return !(involvesUs && involvesPartner);
    });
  }

  async function handleRemoteSessionEnded() {
    state._pendingMeetingId = null;
    clearPartnerPlaybookState();
    removeInstantSessionWithPartnerFromLocal();
    setContactPool(state.contactPool);
    renderActiveMembersPanel();
    updatePartnerInstantRow();
    updateSessionActionHighlight();
    updateMeetingPanels();
    setMeetingStatusOnAll("Partner ended the session.", "ok");
    try {
      await refreshMeetingsFromServer();
    } catch (_) {
      /* optimistic local update already applied */
    }
  }

  function syncJoinedSessionState() {
    if (!state.sessionJoinedMeetingId) return;
    const meeting = state.meetings.find((m) => m.id === state.sessionJoinedMeetingId);
    if (!meeting || meeting.status !== "live" || meeting.mode !== "instant") {
      clearPartnerPlaybookState();
      updateMeetingPanels();
      updatePartnerInstantRow();
      updateSessionActionHighlight();
      setContactPool(state.contactPool);
      return;
    }
    refreshPartnerPlaybookIfNeeded().catch(() => {});
  }

  async function maybeRefreshChatFromServer(threads) {
    if (!state.threadId || !state.loaded || !Array.isArray(threads)) return;
    const activeThread = threads.find((t) => t.id === state.threadId);
    if (!activeThread) return;
    const serverAt = activeThread.lastMessageAt || null;
    if (state.threadLastMessageAt == null) {
      state.threadLastMessageAt = serverAt;
      return;
    }
    if (serverAt !== state.threadLastMessageAt) {
      try {
        await loadThreadMessages(state.threadId);
      } catch (err) {
        console.warn("[social] chat sync failed:", err);
      }
    }
  }

  async function refreshMeetingsFromServer() {
    if (!isLoggedIn()) return;
    const data = await api("/api/social/bootstrap");
    state.meetings = data.meetings || [];
    if (Array.isArray(data.activeMembers)) {
      applyActiveMembersFromServer(data.activeMembers);
    }
    setContactPool(data.contacts || []);
    updateMeetingPanels();
    applyHostPeerIdFromMeetings();
    syncJoinedSessionState();
    await maybeRefreshChatFromServer(data.threads || []);
    await refreshPartnerPlaybookIfNeeded();
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

  async function loadPartnerPlaybook(partnerUserId, { force = false } = {}) {
    const id = String(partnerUserId || "").trim();
    if (!id) return null;
    const data = await api(`/api/social/partners/${encodeURIComponent(id)}/playbook`);
    const profile = data.profile;
    if (!profile) return null;
    const fp = partnerPlaybookFingerprint(profile);
    const unchanged =
      !force && id === lastPartnerPlaybookPartnerId && fp === lastPartnerPlaybookFingerprint;
    lastPartnerPlaybookPartnerId = id;
    lastPartnerPlaybookFingerprint = fp;
    if (!unchanged && global.MemberProfile?.setPartnerProfile) {
      global.MemberProfile.setPartnerProfile(profile);
    }
    if (profile.chatColors) applyPartnerChatColors({ chatColors: profile.chatColors });
    if (profile.playModeSound) applyPartnerPlayModeSound({ playModeSound: profile.playModeSound });
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
    tryAutoJoinPartnerCall(meeting.hostPeerId);
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
        ? "Joined — connected. Click Start Camera or Start Micro when ready."
        : "Joined — waiting for partner Session ID, then camera/audio go live instantly.",
      "ok"
    );
    updatePartnerInstantRow();
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

  function isActiveInstantSession() {
    const partnerId = getCoupledPartnerId();
    return Boolean(
      isSessionJoined() ||
        findActiveInstantSessionWithPartner(partnerId) ||
        findMyPendingProviderMeeting() ||
        findPartnerLiveMeeting()
    );
  }

  function tryAutoJoinPartnerCall(remoteId) {
    const peerId = String(remoteId || "").trim();
    if (!peerId || global.appHasPeerConnection?.()) return;
    if (!isActiveInstantSession() && !isSessionJoined()) return;
    global.DualPeerConnect?.joinPartnerCall?.(peerId).catch(() => {});
  }

  function tryPrepareHostCall() {
    if (global.appHasPeerConnection?.()) return;
    if (!findMyPendingProviderMeeting() && !findActiveInstantSessionWithPartner(getCoupledPartnerId())) {
      return;
    }
    global.DualPeerConnect?.prepareHostCall?.().catch(() => {});
  }

  function updateSessionActionHighlight() {
    const startBtn = document.getElementById("btnStartHost");
    const joinBtn = document.getElementById("btnConnect");
    if (!startBtn || !joinBtn) return;

    const inCall = global.appSessionRole?.() === "host" || global.appSessionRole?.() === "guest";
    const instantActive = isActiveInstantSession();
    const cameraOn = global.appLocalCameraActive?.() ?? false;
    const micOn = global.appLocalMicEnabled?.() ?? false;
    const peerUp = global.appHasPeerConnection?.() ?? inCall;

    startBtn.classList.remove("primary", "secondary", "session-action-glow");
    joinBtn.classList.remove("primary", "secondary", "session-action-glow");

    if (instantActive || inCall) {
      if (!cameraOn) {
        startBtn.classList.add("primary", "session-action-glow");
      } else {
        startBtn.classList.add("secondary");
      }

      if (peerUp && !micOn) {
        joinBtn.classList.add("primary", "session-action-glow");
      } else {
        joinBtn.classList.add("secondary");
      }

      if (!startBtn.disabled) {
        startBtn.title = cameraOn
          ? "Stop Camera (session stays connected)"
          : peerUp
            ? "Start Camera — your partner sees video immediately"
            : "Start Camera (video + Session ID)";
      }
      if (!joinBtn.disabled) {
        joinBtn.title = micOn
          ? "Stop Micro (mute microphone/audio)"
          : peerUp
            ? "Start Micro — your partner hears you immediately"
            : "Start Micro (enable microphone/audio)";
      }
      return;
    }

    const partnerLive = findPartnerLiveMeeting();
    const myTurnToStart = findMyPendingProviderMeeting();

    if (partnerLive) {
      startBtn.classList.add("primary", "session-action-glow");
      joinBtn.classList.add("secondary");
      if (!startBtn.disabled) {
        startBtn.title = "Partner is live — click Start Camera to connect video";
      }
      return;
    }

    if (myTurnToStart) {
      startBtn.classList.add("primary", "session-action-glow");
      joinBtn.classList.add("secondary");
      if (!startBtn.disabled) {
        startBtn.title = "Start Camera (video + Session ID)";
      }
      return;
    }

    startBtn.classList.add("secondary");
    joinBtn.classList.add("secondary");
    if (!startBtn.disabled) {
      startBtn.title = "Start Camera (video + Session ID)";
    }
    if (!joinBtn.disabled) {
      joinBtn.title = "Start Micro (enable microphone/audio)";
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
        guestStatus.textContent = "Session ID ready — connecting to partner …";
        guestStatus.className = "status-line ok";
      }
    }
    tryAutoJoinPartnerCall(peerId);
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

  function appendTechniqueMessageLocal(senderName, label, isLocal, ts, messageId) {
    const uid = getSessionUserId();
    const at = ts || Date.now();
    const name = String(senderName || "Partner").trim();
    const action = String(label || "").trim();
    if (!action) return;
    const id = messageId || `technique-${at}-${Math.random().toString(36).slice(2, 9)}`;
    if (state.messages.some((m) => m.id === id)) return;
    setMessages(
      mergeMessages(state.messages, [
        {
          id,
          senderUserId: isLocal ? uid : null,
          senderName: isLocal ? "You" : name,
          body: action,
          kind: "technique",
          createdAt: at,
        },
      ])
    );
  }

  async function sendTechniqueMessage(label, ts = Date.now()) {
    const action = String(label || "").trim().slice(0, 2000);
    if (!action) return null;
    const at = ts || Date.now();
    if (!isLoggedIn()) {
      appendTechniqueMessageLocal("You", action, true, at);
      return null;
    }
    const tempId = `technique-pending-${at}-${Math.random().toString(36).slice(2, 7)}`;
    appendTechniqueMessageLocal("You", action, true, at, tempId);
    try {
      const msg = await sendPersistentMessage(action, { kind: "technique" });
      if (msg) {
        state.messages = state.messages.filter((m) => m.id !== tempId);
        setMessages(mergeMessages(state.messages, [msg]));
      }
      return msg;
    } catch (err) {
      console.warn("[social] technique message failed:", err);
      return null;
    }
  }

  async function reloadChatMessages({ skipBell = false } = {}) {
    if (!state.threadId || !isLoggedIn()) return;
    await loadThreadMessages(state.threadId, { skipBell });
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
    if (hostHint && state.inviteHost) {
      hostHint.hidden = false;
      hostHint.innerHTML =
        `Your host: <strong>${escapeHtml(state.inviteHost.displayName)}</strong> (@${escapeHtml(state.inviteHost.username)}). ` +
        `Use <strong>Messages</strong> in the header to chat.`;
    }

    applyHostPeerIdFromMeetings();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function formatMeetingScheduleWhen(scheduledStartAt) {
    const start = Number(scheduledStartAt);
    if (!Number.isFinite(start)) return "—";
    return new Date(start).toLocaleString(undefined, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function listUpcomingScheduledMeetings(meetings) {
    const now = Date.now();
    return (meetings || [])
      .filter((m) => {
        if (m.mode !== "scheduled") return false;
        if (m.status === "completed" || m.status === "cancelled") return false;
        const start = Number(m.scheduledStartAt);
        return Number.isFinite(start) && start > now;
      })
      .sort((a, b) => Number(a.scheduledStartAt) - Number(b.scheduledStartAt));
  }

  function updateMeetingPanels() {
    document.querySelectorAll(".js-meeting-list").forEach((list) => {
      list.replaceChildren();
      const upcoming = listUpcomingScheduledMeetings(state.meetings);
      if (!upcoming.length) {
        list.innerHTML = '<p class="status-line">No upcoming sessions scheduled.</p>';
        return;
      }
      for (const m of upcoming.slice(0, 12)) {
        const row = document.createElement("div");
        row.className = "meeting-list-item";
        const body = document.createElement("div");
        body.className = "meeting-list-item-body";
        const partner = m.isHost ? m.guest : m.host;
        const when = formatMeetingScheduleWhen(m.scheduledStartAt);
        body.innerHTML =
          `<div class="meeting-list-when">${escapeHtml(when)}</div>` +
          `<div class="meeting-list-meta">` +
          (partner ? `with ${escapeHtml(partner.displayName)}` : "Scheduled session") +
          `</div>` +
          (m.googleEventId ? `<span class="status-line ok">Google Calendar synced</span>` : "");
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
    renderActiveMembersPanel();
    renderContactPoolPanel();
    updateSessionActionHighlight();
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

  function setInstantSessionButtonMode(active) {
    const btn = document.getElementById("btnStartInstantSession");
    if (!btn) return;
    const icon = btn.querySelector("i");
    const label = btn.querySelector(".setup-instant-session-label");
    if (active) {
      btn.dataset.sessionAction = "stop";
      btn.classList.remove("primary");
      btn.classList.add("secondary");
      if (icon) icon.className = "bi bi-stop-circle";
      if (label) label.textContent = "Stop current session";
      btn.title = "End the instant session for you and your partner";
    } else {
      btn.dataset.sessionAction = "start";
      btn.classList.add("primary");
      btn.classList.remove("secondary");
      if (icon) icon.className = "bi bi-lightning-charge";
      if (label) label.textContent = "Start instant session";
      btn.title = "Start an instant session with your partner";
    }
  }

  function setPartnerInstantStatus(msg, cls = "ok") {
    const el = document.getElementById("setupPartnerInstantStatus");
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.className = `status-line setup-partner-instant-status ${cls}`;
    el.textContent = msg;
  }

  function updatePartnerInstantRow() {
    const row = document.getElementById("setupPartnerInstantRow");
    const btn = document.getElementById("btnStartInstantSession");
    if (!row || !btn) return;
    const partnerId = getCoupledPartnerId();
    const active = partnerId ? findActiveInstantSessionWithPartner(partnerId) : null;
    row.hidden = !partnerId;
    btn.disabled = !partnerId || meetingCreateInFlight;
    setInstantSessionButtonMode(Boolean(active));
    updateSessionActionHighlight();
  }

  async function stopCurrentInstantSession(meeting) {
    const active = meeting || findActiveInstantSessionWithPartner(getCoupledPartnerId());
    if (!active?.id) {
      setPartnerInstantStatus("No active instant session to stop.", "err");
      return;
    }
    if (meetingCreateInFlight) return;
    if (!window.confirm("Stop the current session for you and your partner?")) return;
    meetingCreateInFlight = true;
    const btn = document.getElementById("btnStartInstantSession");
    if (btn) btn.disabled = true;
    try {
      if (global.appSessionRole?.()) {
        global.DualPeerConnect?.hangup?.({ skipSessionPause: true });
      }
      await deleteMeeting(active.id);
      state._pendingMeetingId = null;
      clearPartnerPlaybookState();
      setPartnerInstantStatus("Session stopped for both partners.", "ok");
      setMeetingStatusOnAll("Session stopped for both partners.", "ok");
      broadcastMeetingsChanged();
    } catch (err) {
      const errMsg = err?.message || "Could not stop session.";
      setPartnerInstantStatus(errMsg, "err");
      setMeetingStatusOnAll(errMsg, "err");
    } finally {
      meetingCreateInFlight = false;
      updatePartnerInstantRow();
    }
  }

  async function startInstantSessionForPartner(partnerId) {
    const id = String(partnerId || "").trim();
    if (!id) {
      setPartnerInstantStatus("Select a partner for this session first.", "err");
      return;
    }
    if (meetingCreateInFlight) return;
    meetingCreateInFlight = true;
    const btn = document.getElementById("btnStartInstantSession");
    if (btn) btn.disabled = true;
    try {
      const meeting = await createMeeting({
        mode: "instant",
        partnerUserId: id,
        syncGoogle: state.calendar.connected,
      });
      const msg = global.DualPeerAuth?.isAccountHost?.()
        ? "Instant session — Start Camera and Start Micro glow pink when ready."
        : "Instant session — click Join, then Start Camera / Start Micro (pink).";
      setPartnerInstantStatus(msg, "ok");
      setMeetingStatusOnAll(msg, "ok");
      document.getElementById("btnStartHost")?.focus();
      state._pendingMeetingId = meeting?.id;
      tryPrepareHostCall();
    } catch (err) {
      const errMsg = err?.message || "Could not start instant session.";
      setPartnerInstantStatus(errMsg, "err");
      setMeetingStatusOnAll(errMsg, "err");
    } finally {
      meetingCreateInFlight = false;
      updatePartnerInstantRow();
    }
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
            if (action === "later") {
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

  async function removeFromModelPool(memberId) {
    const id = String(memberId || "").trim();
    if (!id || !isLoggedIn()) return false;
    try {
      await api(`/api/social/model-pool/${encodeURIComponent(id)}`, { method: "DELETE" });
      state.contactPool = state.contactPool.filter((c) => c.id !== id);
      state.modelPool = state.modelPool.filter((c) => c.id !== id);
      if (state.sessionPartnerId === id) {
        coupleSessionWithPartner(null, { addToMembers: false });
      }
      state.activeMembers = state.activeMembers.filter((m) => m.id !== id);
      renderActiveMembersPanel();
      await bootstrap({ loadChat: false });
      return true;
    } catch (err) {
      console.warn("[social] remove from pool failed:", err);
      return false;
    }
  }

  async function loadPremiumPartners() {
    state.premiumPartners = [];
    if (!canAccessPremiumPartners()) {
      renderContactPoolPanel();
      return;
    }
    try {
      const data = await global.DualPeerAuth?.fetchPremiumModels?.();
      state.premiumPartners = (data?.models || []).map((m) => ({
        ...m,
        signedIn: Boolean(m.online),
        isPremiumPartner: true,
        isModel: true,
      }));
    } catch (err) {
      console.warn("[social] premium partners failed:", err);
    }
    renderContactPoolPanel();
  }

  async function loadModelPool() {
    if (!isLoggedIn()) {
      state.modelPool = [];
      state.premiumPartners = [];
      state.sessionBookings = [];
      setContactPool([]);
      renderActiveMembersPanel();
      const bookingsSection = document.getElementById("sessionBookingsSection");
      if (bookingsSection) bookingsSection.hidden = true;
      return;
    }
    try {
      const data = await api("/api/social/model-pool");
      state.modelPool = data.models || [];
      setContactPool([...state.contactPool, ...state.modelPool]);
      await loadPremiumPartners();
      await loadSessionBookings();
    } catch (err) {
      console.warn("[social] model pool failed:", err);
    }
  }

  function renderContactPoolPanel() {
    const root = document.getElementById("modelPoolList");
    const status = document.getElementById("modelPoolStatus");
    const premiumSection = document.getElementById("premiumPartnersSection");
    const premiumRoot = document.getElementById("premiumPartnersList");
    const premiumStatus = document.getElementById("premiumPartnersStatus");
    if (!root) return;

    const showPremium = canAccessPremiumPartners();
    if (premiumSection) premiumSection.hidden = !showPremium;

    const regularContacts = state.contactPool.filter((c) => !c.isPremiumPartner);
    const poolPartners = state.contactPool.filter((c) => c.isPremiumPartner);
    const premiumContacts = mergeContactPools(state.premiumPartners, poolPartners);
    const renderKey = contactPoolRenderKey(regularContacts, premiumContacts, showPremium);

    if (renderKey === state.contactPoolRenderKey && root.childElementCount > 0) {
      restoreExpandedPoolMemberPreview();
      return;
    }
    state.contactPoolRenderKey = renderKey;

    root.replaceChildren();
    if (!regularContacts.length) {
      if (status) {
        status.className = "status-line";
        status.textContent =
          "No contacts yet — invite someone or complete a session to build your pool.";
      }
    } else {
      if (status) {
        status.className = "status-line ok";
        status.textContent =
          `${regularContacts.length} contact${regularContacts.length === 1 ? "" : "s"} · click for profile · double-click for Current Chat Partner`;
      }
      for (const m of regularContacts) {
        root.appendChild(
          buildPoolEntry(m, {
            variant: "pool",
            onActivate: (contact) => {
              addActiveMember(contact).then((ok) => {
                if (!ok) return;
                const st = document.getElementById("setupActiveMembersStatus");
                if (st) {
                  st.hidden = false;
                  st.className = "status-line ok";
                  st.textContent = `${contact.displayName} is now your Current Chat Partner — they will see you there too.`;
                }
              });
            },
            onRemove: (contactId) => {
              void removeFromModelPool(contactId);
            },
          })
        );
      }
    }

    if (!premiumRoot) {
      restoreExpandedPoolMemberPreview();
      return;
    }
    premiumRoot.replaceChildren();
    if (!showPremium) {
      restoreExpandedPoolMemberPreview();
      return;
    }

    if (!premiumContacts.length) {
      if (premiumStatus) {
        premiumStatus.className = "status-line";
        premiumStatus.textContent =
          "No Premium Partners in your pool yet — they appear here when you add or book them.";
      }
      restoreExpandedPoolMemberPreview();
      return;
    }

    if (premiumStatus) {
      premiumStatus.className = "status-line ok";
      premiumStatus.textContent = `${premiumContacts.length} Premium Partner${premiumContacts.length === 1 ? "" : "s"} · click for profile · double-click for Current Chat Partner`;
    }
    for (const m of premiumContacts) {
      premiumRoot.appendChild(
        buildPoolEntry(m, {
          variant: "pool",
          premiumPartner: true,
          onActivate: (contact) => {
            addActiveMember(contact).then((ok) => {
              if (!ok) return;
              const st = document.getElementById("setupActiveMembersStatus");
              if (st) {
                st.hidden = false;
                st.className = "status-line ok";
                st.textContent = `${contact.displayName} is now your Current Chat Partner — they will see you there too.`;
              }
            });
          },
        })
      );
    }

    restoreExpandedPoolMemberPreview();
  }

  function getActiveSessionPartner() {
    const partner = singleSessionPartnerFromList(state.activeMembers);
    if (!partner) return null;
    const poolEntry = state.contactPool.find((c) => c.id === partner.id);
    return poolEntry ? { ...partner, signedIn: poolEntry.signedIn } : partner;
  }

  function renderActiveMembersPanel() {
    const root = document.getElementById("setupModelPoolList");
    const status = document.getElementById("setupModelPoolStatus");
    if (!root) return;
    root.replaceChildren();
    const partner = getActiveSessionPartner();
    if (!partner) {
      if (status) {
        status.className = "status-line";
        status.textContent = "No partner selected — double-click someone in Member Pool (right).";
      }
      setPartnerInstantStatus("");
      updatePartnerInstantRow();
      return;
    }
    state.activeMembers = [partner];
    if (status) {
      status.className = "status-line ok";
      status.textContent = `Partner for this session: ${partner.displayName || partner.username}.`;
    }
    root.appendChild(
      buildMemberCard(partner, {
        variant: "active",
        selected: true,
        onSelect: (member) => coupleSessionWithPartner(member.id, { addToMembers: true }),
        onRemove: (id) => removeActiveMember(id),
      })
    );
    updatePartnerInstantRow();
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
      st.textContent = "Partner cleared — pick from Member Pool (right).";
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
        opt.textContent = `${p.displayName} (@${p.username})`;
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
    const loggedIn = isLoggedIn();
    if (btn) {
      btn.disabled = !loggedIn;
      btn.hidden = false;
    }
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
    document.getElementById("btnClearActiveMembers")?.addEventListener("click", async () => {
      await clearActiveMembers({ clearStorage: true, clearChat: true });
      const st = document.getElementById("setupActiveMembersStatus");
      if (st) {
        st.hidden = false;
        st.className = "status-line ok";
        st.textContent = "Partner and chat cleared — pick from Member Pool (right).";
      }
      setPartnerInstantStatus("");
      updatePartnerInstantRow();
    });
  }

  function initPartnerInstantSession() {
    document.getElementById("btnStartInstantSession")?.addEventListener("click", () => {
      const partnerId = getCoupledPartnerId();
      if (findActiveInstantSessionWithPartner(partnerId)) {
        stopCurrentInstantSession();
        return;
      }
      startInstantSessionForPartner(partnerId);
    });
  }

  function initLiveChatToolbar() {
    document.getElementById("btnDeleteLastChat")?.addEventListener("click", async () => {
      try {
        await deleteLastChatMessage();
      } catch (err) {
        setChatClearStatus(err?.message || "Could not delete last message.", "err");
      }
    });
    document.getElementById("btnClearLiveChat")?.addEventListener("click", async () => {
      try {
        await clearLiveChat({ deleteServer: true });
        setChatClearStatus("Chat cleared.");
      } catch (err) {
        setChatClearStatus(err?.message || "Could not clear chat.", "err");
      }
    });
  }

  function handleBookingRedirect() {
    const params = new URLSearchParams(location.search);
    const bookingFlag = params.get("booking");
    if (!bookingFlag) return;

    document.querySelector('[data-remote-tab="modelpool"]')?.click();
    void loadSessionBookings();

    if (bookingFlag === "success") {
      const st = document.getElementById("sessionBookingsStatus");
      if (st) {
        st.hidden = false;
        st.className = "status-line ok";
        st.textContent = "Payment received — session is confirmed in escrow.";
      }
    }

    params.delete("booking");
    params.delete("id");
    const qs = params.toString();
    const next = `${location.pathname}${qs ? `?${qs}` : ""}${location.hash || ""}`;
    history.replaceState(null, "", next);
  }

  function init() {
    listenBroadcast();
    mountMeetingBlocks();
    initMeetingBlocks();
    initAddToModelPool();
    initMembersToolbar();
    initPartnerInstantSession();
    initLiveChatToolbar();
    initHeaderChatSend();
    handleCalendarRedirect();
    handleBookingRedirect();

    global.addEventListener("dualpeer-auth-change", () => refreshAuthUi());
    global.addEventListener("dualpeer-account-role-change", () => {
      loadPremiumPartners().catch(() => {});
      loadSessionBookings().catch(() => {});
    });
    global.addEventListener("dualpeer:bookings-changed", () => {
      loadSessionBookings().catch(() => {});
    });
    global.addEventListener("dualpeer-session-role", () => {
      updateSessionActionHighlight();
      refreshPartnerPlaybookIfNeeded().catch(() => {});
    });
    global.addEventListener("dualpeer-session-joined", () => {
      refreshPartnerPlaybookIfNeeded().catch(() => {});
      updateSessionActionHighlight();
    });
    global.addEventListener("dualpeer-partner-profile", (e) => {
      const profile = e.detail?.profile;
      if (profile) {
        lastPartnerPlaybookFingerprint = partnerPlaybookFingerprint(profile);
      } else {
        resetPartnerPlaybookCache();
      }
    });
    global.addEventListener("dualpeer-chat-colors-updated", () => {
      renderMessages({ skipBroadcast: true });
    });
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
    appendTechniqueMessageLocal,
    sendTechniqueMessage,
    reloadChatMessages,
    clearChatAfterSession,
    clearLiveChat,
    deleteLastChatMessage,
    applyDeleteLastMessage,
    resetSocialClientState,
    publishHostPeerId,
    getActiveLiveMeetingId,
    resolveLiveMeetingId,
    applyHostPeerIdFromMeetings,
    updateSessionActionHighlight,
    joinInstantMeeting,
    loadPartnerPlaybook,
    refreshPartnerPlaybookIfNeeded,
    onPartnerDisconnected,
    handleRemoteSessionEnded,
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
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
