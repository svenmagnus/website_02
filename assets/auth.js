/**
 * Member accounts — login, register (invite + email verify), profile API.
 */
(function (global) {
  const SESSION_KEY = "dualpeer-member-session";
  const PROFILE_CACHE_KEY = "dualpeer-member-profile-cache";

  const PRESET_TECHNIQUES = global.DualPeerTechniques?.allPresets?.() || [];

  let readyResolve;
  const readyPromise = new Promise((r) => {
    readyResolve = r;
  });

  function isTangentClubSite() {
    return /(^|\.)tangent-club\.com$/i.test(location.hostname);
  }

  function resolveApiBase() {
    const params = new URLSearchParams(location.search);
    const apiOverride = params.get("api");
    if (apiOverride && /^https?:\/\//i.test(apiOverride)) {
      return String(apiOverride).replace(/\/$/, "");
    }
    const fromWindow = global.DUALPEER_WHIP_URL;
    if (fromWindow && String(fromWindow).trim()) {
      return String(fromWindow).replace(/\/$/, "");
    }
    if (location.port === "8787") return location.origin;
    if (
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1" ||
      location.hostname === "[::1]"
    ) {
      return `${location.protocol}//${location.hostname}:8787`;
    }
    if (isTangentClubSite()) {
      const tunnel = String(global.WHIP_CLOUDFLARE_TUNNEL_URL || "").trim().replace(/\/$/, "");
      if (tunnel && /^https:\/\//i.test(tunnel) && !/REPLACE|YOUR[-_]?SUBDOMAIN/i.test(tunnel)) {
        return tunnel;
      }
      return "";
    }
    return "http://127.0.0.1:8787";
  }

  function apiUnreachableMessage(base) {
    if (isTangentClubSite()) {
      if (!base) {
        return (
          "API server not configured: set WHIP_CLOUDFLARE_TUNNEL_URL in assets/app.js, " +
          "push to GitHub, then reload the page."
        );
      }
      return (
        `API unreachable at ${base}. On your Mac: cd server && npm run restart ` +
        "and in a second terminal npm run tunnel — update the tunnel URL in assets/app.js and push."
      );
    }
    if (!base) return "API server not configured.";
    return `API unreachable (${base}). Is the server running? cd server && npm run restart`;
  }

  function getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function setSession(token, user) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token, user, at: Date.now() }));
    if (user) cacheProfile(userToProfile(user));
    updateAccountMenuAuthState();
    global.dispatchEvent(new CustomEvent("dualpeer-auth-change", { detail: { loggedIn: true, user } }));
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(PROFILE_CACHE_KEY);
    updateAccountMenuAuthState();
    global.dispatchEvent(new CustomEvent("dualpeer-auth-change", { detail: { loggedIn: false } }));
  }

  function userToProfile(user) {
    if (!user) return null;
    return {
      displayName: user.displayName || user.username || "Guest",
      gender: user.gender || "",
      bio: user.bio || "",
      lovenseToys: user.lovenseToys || "",
      techniques: user.techniques || [],
      customTechniques: user.customTechniques || [],
      username: user.username,
    };
  }

  function cacheProfile(profile) {
    if (!profile) return;
    try {
      localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(profile));
    } catch (_) {
      /* ignore */
    }
  }

  function getCachedProfile() {
    try {
      const raw = localStorage.getItem(PROFILE_CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function isLoggedIn() {
    return Boolean(getSession()?.token);
  }

  function stripAuthQueryParams() {
    const url = new URL(location.href);
    let changed = false;
    ["premium", "verified", "onboard"].forEach((key) => {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    });
    if (location.hash === "#premium") {
      url.hash = "";
      changed = true;
    }
    if (changed) {
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
  }

  /** Logged-in user enters main app (no welcome.html); optional Profil tab + banner. */
  function enterAppAfterAuth({ showProfile = true } = {}) {
    if (!document.getElementById("siteAccessForm")) {
      window.location.href = showProfile ? "index.html?onboard=1" : "index.html";
      return;
    }
    closePremiumLoginModal();
    if (global.dualPeerSiteAccess?.grant) global.dualPeerSiteAccess.grant();
    else global.dispatchEvent(new CustomEvent("dualpeer-site-access-granted"));
    if (showProfile) {
      if (global.MemberProfile?.enterProfileWorkspace) {
        global.MemberProfile.enterProfileWorkspace({ onboarding: true });
      } else {
        global.dispatchEvent(
          new CustomEvent("dualpeer-enter-profile", { detail: { onboarding: true } })
        );
      }
    }
    stripAuthQueryParams();
  }

  function goToWelcomePage() {
    enterAppAfterAuth({ showProfile: true });
  }

  function authHeaders() {
    const token = getSession()?.token;
    return token
      ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
      : { "Content-Type": "application/json" };
  }

  const MAIL_PASSWORD_PLACEHOLDERS = new Set([
    "strato-postfach-passwort",
    "strato postfach-passwort",
    "••••••••",
    "********",
  ]);

  function isPlaceholderMailPassword(value) {
    const v = String(value ?? "").trim().toLowerCase();
    if (!v) return true;
    return MAIL_PASSWORD_PLACEHOLDERS.has(v);
  }

  function syncMailPortSecureUi() {
    const portEl = document.getElementById("mailOutPort");
    const secureEl = document.getElementById("mailOutSecure");
    if (!(portEl instanceof HTMLInputElement) || !(secureEl instanceof HTMLInputElement)) return;
    const port = Number(portEl.value) || 587;
    if (port === 465) {
      secureEl.checked = true;
      secureEl.disabled = true;
    } else if (port === 587) {
      secureEl.checked = false;
      secureEl.disabled = true;
    } else {
      secureEl.disabled = false;
    }
  }

  async function api(path, options = {}) {
    const base = resolveApiBase();
    if (!base) {
      const err = new Error(apiUnreachableMessage(""));
      err.code = "api_not_configured";
      throw err;
    }
    const { timeoutMs = 0, signal: externalSignal, ...fetchOptions } = options;
    const controller = new AbortController();
    let timeoutId = null;
    let abortedByUser = false;
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }
    if (externalSignal) {
      if (externalSignal.aborted) {
        abortedByUser = true;
        controller.abort();
      } else {
        externalSignal.addEventListener(
          "abort",
          () => {
            abortedByUser = true;
            controller.abort();
          },
          { once: true }
        );
      }
    }
    let resp;
    try {
      resp = await fetch(`${base}${path}`, {
        ...fetchOptions,
        signal: controller.signal,
        headers: { ...authHeaders(), ...(fetchOptions.headers || {}) },
      });
    } catch (fetchErr) {
      if (fetchErr?.name === "AbortError") {
        const err = new Error(
          abortedByUser
            ? "Request cancelled."
            : "Request timed out. Check SMTP settings or try again."
        );
        err.code = abortedByUser ? "request_aborted" : "timeout";
        throw err;
      }
      const err = new Error(apiUnreachableMessage(base));
      err.code = "network_error";
      throw err;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(data.message || data.error || `Request failed (${resp.status})`);
      err.code = data.error;
      err.status = resp.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function checkApiHealth() {
    const base = resolveApiBase();
    if (!base) return { ok: false, base, error: "api_not_configured" };
    try {
      const resp = await fetch(`${base}/health`, { cache: "no-store" });
      return { ok: resp.ok, base };
    } catch (_) {
      return { ok: false, base, error: "network_error" };
    }
  }

  async function login(username, password) {
    const u = String(username ?? "").trim();
    const p = String(password ?? "");
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: u, password: p }),
    });
    setSession(data.token, data.user);
    return data.user;
  }

  async function register(payload) {
    return api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async function resendVerification(username, password) {
    return api("/api/auth/resend-verification", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  }

  async function verifyEmail(token) {
    return api(`/api/auth/verify-email/${encodeURIComponent(token)}`);
  }

  async function logout() {
    try {
      if (isLoggedIn()) await api("/api/auth/logout", { method: "POST" });
    } catch (_) {
      /* ignore */
    }
    clearSession();
  }

  async function fetchProfile() {
    const data = await api("/api/profile");
    const profile = userToProfile(data.profile);
    cacheProfile(profile);
    if (global.dualPeerUi?.setProfileName) {
      global.dualPeerUi.setProfileName(profile.displayName);
    }
    return profile;
  }

  async function updateProfile(patch) {
    const data = await api("/api/profile", {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    const profile = userToProfile(data.profile);
    cacheProfile(profile);
    if (global.dualPeerUi?.setProfileName) {
      global.dualPeerUi.setProfileName(profile.displayName);
    }
    global.dispatchEvent(new CustomEvent("dualpeer-profile-update", { detail: { profile } }));
    return profile;
  }

  async function sendInvite(email, options = {}) {
    return api("/api/invites", {
      method: "POST",
      body: JSON.stringify({ email }),
      timeoutMs: 20000,
      ...options,
    });
  }

  async function validateInviteToken(token) {
    return api(`/api/auth/invite/${encodeURIComponent(token)}`);
  }

  function isSessionGuest() {
    return global.dualPeerSession?.getRole?.() === "guest";
  }

  /** Logged-in host account; hidden only while connected as session guest. */
  function canManageInvites() {
    return isLoggedIn() && !isSessionGuest();
  }

  function openPremiumLoginModal() {
    const modal = document.getElementById("premiumLoginModal");
    if (!modal) {
      window.location.href = "index.html?premium=1";
      return;
    }
    if (global.dualPeerUi?.openAuthModal) {
      global.dualPeerUi.openAuthModal("premiumLoginModal");
    } else {
      modal.hidden = false;
      if (global.dualPeerUi?.closeAccountMenu) global.dualPeerUi.closeAccountMenu();
    }
    const params = new URLSearchParams(location.search);
    const banner = document.getElementById("loginVerifiedBanner");
    if (banner && params.get("verified") === "1") {
      banner.hidden = false;
      banner.textContent = "Email confirmed — you can sign in now.";
    }
    document.getElementById("loginUsername")?.focus();
  }

  function closePremiumLoginModal() {
    if (global.dualPeerUi?.closeAuthModals) global.dualPeerUi.closeAuthModals();
    else {
      const modal = document.getElementById("premiumLoginModal");
      if (modal) modal.hidden = true;
    }
    const errEl = document.getElementById("loginError");
    if (errEl) errEl.hidden = true;
  }

  function openMailSettingsModal() {
    if (!isLoggedIn()) {
      openPremiumLoginModal();
      return;
    }
    if (global.dualPeerUi?.openAuthModal) {
      global.dualPeerUi.openAuthModal("mailSettingsModal");
    } else {
      const modal = document.getElementById("mailSettingsModal");
      if (modal) modal.hidden = false;
      if (global.dualPeerUi?.closeAccountMenu) global.dualPeerUi.closeAccountMenu();
    }
    loadProfileMailSettings();
  }

  function closeMailSettingsModal() {
    if (global.dualPeerUi?.closeAuthModals) global.dualPeerUi.closeAuthModals();
    else {
      const modal = document.getElementById("mailSettingsModal");
      if (modal) modal.hidden = true;
    }
  }

  function fillMailForm(mail) {
    const out = mail?.outgoing || {};
    const inc = mail?.incoming || {};
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el instanceof HTMLInputElement) el.value = val ?? "";
    };
    set("mailOutHost", out.host);
    set("mailOutPort", String(out.port || 465));
    set("mailOutUser", out.user);
    set("mailOutFrom", out.from);
    set("mailInHost", inc.host);
    set("mailInPort", String(inc.port || 993));
    set("mailInUser", inc.user);
    const passEl = document.getElementById("mailOutPassword");
    if (passEl instanceof HTMLInputElement) {
      passEl.type = "password";
      passEl.value = "";
      passEl.autocomplete = "new-password";
      passEl.placeholder = mail?.hasPassword
        ? "••••••••  (saved — leave blank to keep)"
        : "Mailbox password";
    }
    const secure = document.getElementById("mailOutSecure");
    if (secure instanceof HTMLInputElement) {
      const port = Number(out.port) || 587;
      if (port === 465) secure.checked = true;
      else if (port === 587) secure.checked = false;
      else secure.checked = Boolean(out.secure);
    }
    syncMailPortSecureUi();
    const hint = document.getElementById("mailPasswordHint");
    if (hint) {
      hint.textContent = mail?.hasPassword
        ? "Password is saved — only fill in if you want to change it."
        : "Enter your mailbox password (e.g. Strato webmail password).";
    }
    const status = document.getElementById("profileMailStatus");
    if (status) {
      status.className = mail?.configured ? "status-line ok" : "status-line";
      status.textContent = mail?.configured
        ? "Email delivery active — invitations are sent via your mailbox."
        : "No outgoing server yet — share invite link/code manually.";
    }
  }

  async function fetchMailSettings() {
    return api("/api/profile/mail");
  }

  async function saveMailSettings(payload, options = {}) {
    return api("/api/profile/mail", {
      method: "PATCH",
      body: JSON.stringify(payload),
      timeoutMs: 15000,
      ...options,
    });
  }

  async function testMailSettings(to, options = {}) {
    return api("/api/profile/mail/test", {
      method: "POST",
      body: JSON.stringify(to ? { to } : {}),
      timeoutMs: 20000,
      ...options,
    });
  }

  function readMailFormPayload() {
    const port = Number(document.getElementById("mailOutPort")?.value) || 587;
    let secure = false;
    if (port === 465) secure = true;
    else if (port === 587) secure = false;
    else {
      const secureEl = document.getElementById("mailOutSecure");
      secure = secureEl instanceof HTMLInputElement ? secureEl.checked : false;
    }
    const user = document.getElementById("mailOutUser")?.value?.trim() || "";
    const payload = {
      outgoing: {
        host: document.getElementById("mailOutHost")?.value?.trim() || "",
        port,
        secure,
        user,
        from: document.getElementById("mailOutFrom")?.value?.trim() || user,
      },
      incoming: {
        host: document.getElementById("mailInHost")?.value?.trim() || "",
        port: Number(document.getElementById("mailInPort")?.value) || 993,
        secure: true,
        user: document.getElementById("mailInUser")?.value?.trim() || user,
      },
    };
    const pass = document.getElementById("mailOutPassword")?.value?.trim() || "";
    if (pass && !isPlaceholderMailPassword(pass)) payload.password = pass;
    return payload;
  }

  function initProfileMailForm() {
    const form = document.getElementById("profileMailForm");
    const modal = document.getElementById("mailSettingsModal");
    const closeBtn = document.getElementById("mailSettingsModalClose");
    const menuBtn = document.getElementById("btnMailSettings");
    const inviteMailSetup = document.getElementById("inviteModalMailSetup");

    if (closeBtn) {
      closeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeMailSettingsModal();
      });
    }
    if (menuBtn) {
      menuBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (global.dualPeerUi?.closeAccountMenu) global.dualPeerUi.closeAccountMenu();
        openMailSettingsModal();
      });
    }
    if (inviteMailSetup) {
      inviteMailSetup.addEventListener("click", () => {
        const inviteModal = document.getElementById("inviteModal");
        if (inviteModal) inviteModal.hidden = true;
        openMailSettingsModal();
      });
    }
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) {
          e.stopPropagation();
          closeMailSettingsModal();
        }
      });
    }

    if (!form) return;

    const presetBtn = document.getElementById("btnStratoMailPreset");
    const testBtn = document.getElementById("btnMailTest");
    const userInput = document.getElementById("mailOutUser");

    if (userInput) {
      userInput.addEventListener("change", () => {
        const from = document.getElementById("mailOutFrom");
        const imapUser = document.getElementById("mailInUser");
        if (from instanceof HTMLInputElement && !from.value) from.value = userInput.value;
        if (imapUser instanceof HTMLInputElement && !imapUser.value) imapUser.value = userInput.value;
      });
    }

    const portInput = document.getElementById("mailOutPort");
    if (portInput) {
      portInput.addEventListener("change", syncMailPortSecureUi);
      portInput.addEventListener("input", syncMailPortSecureUi);
    }

    if (presetBtn) {
      presetBtn.addEventListener("click", async () => {
        try {
          const data = await fetchMailSettings();
          const p = data.preset || {
            outgoing: { host: "smtp.strato.de", port: 465, secure: true },
            incoming: { host: "imap.strato.de", port: 993, secure: true },
          };
          fillMailForm({
            configured: false,
            hasPassword: false,
            outgoing: p.outgoing,
            incoming: p.incoming,
          });
        } catch (_) {
          fillMailForm({
            configured: false,
            hasPassword: false,
            outgoing: { host: "smtp.strato.de", port: 465, secure: true, user: "", from: "" },
            incoming: { host: "imap.strato.de", port: 993, secure: true, user: "" },
          });
        }
      });
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const status = document.getElementById("profileMailSaveStatus");
      if (status) {
        status.hidden = false;
        status.className = "status-line";
        status.textContent = "Saving…";
      }
      try {
        const data = await saveMailSettings(readMailFormPayload());
        fillMailForm(data.mail);
        if (status) {
          status.className = "status-line ok";
          status.textContent = "Email settings saved.";
        }
      } catch (err) {
        if (status) {
          status.className = "status-line err";
          const map = {
            invalid_mail_settings: "SMTP host and email username are required.",
            mail_password_required: "Enter your mailbox password.",
            invalid_mail_password: "Password is too short.",
            smtp_timeout: "SMTP connection timed out. Try port 465 (SSL) or 587 (STARTTLS).",
            smtp_auth_failed: "SMTP login failed — check email and password.",
            smtp_connection_failed: "Cannot reach the mail server. Check host and port.",
          };
          status.textContent = map[err.code] || err.message;
        }
      }
    });

    if (testBtn) {
      testBtn.addEventListener("click", async () => {
        const status = document.getElementById("profileMailSaveStatus");
        if (status) {
          status.hidden = false;
          status.className = "status-line";
          status.textContent = "Sende Test …";
        }
        testBtn.disabled = true;
        try {
          const result = await testMailSettings(undefined, { timeoutMs: 20000 });
          if (status) {
            status.className = "status-line ok";
            status.textContent = result.message || "Test email sent.";
          }
        } catch (err) {
          if (status) {
            status.className = "status-line err";
            const map = {
              smtp_timeout: "SMTP connection timed out. Check port 465 or 587.",
              smtp_auth_failed: "SMTP login failed — check mailbox password.",
              timeout: "Request timed out.",
            };
            status.textContent = map[err.code] || err.message || "Test failed.";
          }
        } finally {
          testBtn.disabled = false;
        }
      });
    }
  }

  async function loadProfileMailSettings() {
    if (!isLoggedIn()) return;
    try {
      const data = await fetchMailSettings();
      fillMailForm(data.mail);
    } catch (_) {
      fillMailForm({ configured: false, hasPassword: false, outgoing: {}, incoming: {} });
    }
  }

  function updateAccountMenuAuthState() {
    const loggedIn = isLoggedIn();
    const session = getSession();
    const inviteBtn = document.getElementById("btnInviteByEmail");
    const mailBtn = document.getElementById("btnMailSettings");
    const roleEl = document.getElementById("accountRoleLabel") || document.querySelector(".account-role");
    const premiumSetupRow = document.getElementById("premiumSetupRow");
    const premiumSetupHint = document.getElementById("premiumSetupHint");

    document.querySelectorAll(".account-dropdown-premium-only").forEach((el) => {
      el.hidden = !loggedIn;
    });

    if (mailBtn) mailBtn.hidden = !loggedIn;

    if (inviteBtn) {
      const show = loggedIn && canManageInvites();
      inviteBtn.hidden = !show;
      inviteBtn.title = show
        ? "Invite a guest by email"
        : loggedIn
          ? "Unavailable while you are connected as a session guest"
          : "";
    }

    if (roleEl) {
      roleEl.textContent = loggedIn ? "Premium" : "Guest";
      roleEl.classList.toggle("is-premium", loggedIn);
    }
    document.body.classList.toggle("has-premium", loggedIn);

    if (premiumSetupRow) premiumSetupRow.hidden = loggedIn;
    if (premiumSetupHint) {
      premiumSetupHint.textContent = loggedIn
        ? ""
        : "Host features: profile, guest invites, your own SMTP.";
    }

    if (loggedIn && session?.user && global.dualPeerUi?.setProfileName) {
      global.dualPeerUi.setProfileName(session.user.displayName || session.user.username);
    }
  }

  function initInviteModal() {
    const modal = document.getElementById("inviteModal");
    const openBtn = document.getElementById("btnInviteByEmail");
    const closeBtn = document.getElementById("inviteModalClose");
    const sendBtn = document.getElementById("inviteSendBtn");
    const emailInput = document.getElementById("inviteEmailInput");
    const status = document.getElementById("inviteModalStatus");
    const INVITE_SEND_TIMEOUT_MS = 15000;
    let inviteSendAbort = null;

    const resetInviteSendUi = () => {
      if (sendBtn instanceof HTMLButtonElement) sendBtn.disabled = false;
      inviteSendAbort = null;
    };

    const close = () => {
      if (inviteSendAbort) {
        inviteSendAbort.abort();
        inviteSendAbort = null;
      }
      resetInviteSendUi();
      if (global.dualPeerUi?.closeAuthModals) global.dualPeerUi.closeAuthModals();
      else if (modal) modal.hidden = true;
    };
    const open = () => {
      if (!isLoggedIn()) {
        openPremiumLoginModal();
        return;
      }
      if (!canManageInvites()) {
        return;
      }
      if (global.dualPeerUi?.openAuthModal) {
        global.dualPeerUi.openAuthModal("inviteModal");
      } else if (modal) modal.hidden = false;
      if (emailInput instanceof HTMLInputElement) emailInput.focus();
      if (status) status.textContent = "";
    };

    if (openBtn) {
      openBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (global.dualPeerUi?.closeAccountMenu) global.dualPeerUi.closeAccountMenu();
        open();
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        close();
      });
    }
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) close();
      });
    }
    if (sendBtn) {
      sendBtn.addEventListener("click", async () => {
        const email = emailInput instanceof HTMLInputElement ? emailInput.value.trim() : "";
        if (!email) return;
        if (inviteSendAbort) inviteSendAbort.abort();
        inviteSendAbort = new AbortController();
        const signal = inviteSendAbort.signal;
        sendBtn.disabled = true;
        if (status) {
          status.className = "status-line";
          status.textContent = "Sending…";
          status.replaceChildren();
          status.appendChild(document.createTextNode("Sending…"));
        }
        try {
          const result = await sendInvite(email, {
            signal,
            timeoutMs: INVITE_SEND_TIMEOUT_MS,
          });
          const msg = result.emailSent
            ? `Invite sent to ${email} (link and code in the email).`
            : "No SMTP configured — set up Email server (SMTP) in the account menu, or share the link/code below:";
          if (status) {
            status.className = "status-line ok";
            status.replaceChildren();
            status.appendChild(document.createTextNode(msg));
          }
          const mailSetupBtn = document.getElementById("inviteModalMailSetup");
          if (mailSetupBtn) {
            mailSetupBtn.hidden = Boolean(result.emailSent);
          }
          if (!result.emailSent && status && canManageInvites()) {
            if (result.inviteUrl) {
              const link = document.createElement("a");
              link.href = result.inviteUrl;
              link.target = "_blank";
              link.rel = "noopener";
              link.textContent = result.inviteUrl;
              status.appendChild(document.createElement("br"));
              status.appendChild(link);
            }
            if (result.inviteCode) {
              const codeLine = document.createElement("p");
              codeLine.className = "status-line";
              codeLine.style.marginTop = "0.5rem";
              codeLine.innerHTML = `<strong>Invite code:</strong> <code>${result.inviteCode}</code>`;
              status.appendChild(codeLine);
            }
          }
          if (emailInput instanceof HTMLInputElement) emailInput.value = "";
        } catch (err) {
          if (err.code === "request_aborted") return;
          if (status) {
            status.className = "status-line err";
            status.replaceChildren();
            const map = {
              timeout: "Sending timed out. Check SMTP settings or try again.",
              smtp_timeout: "SMTP connection timed out. Check port 465 (SSL) or 587.",
              smtp_auth_failed: "SMTP login failed — check mailbox password in Email server settings.",
            };
            status.appendChild(
              document.createTextNode(map[err.code] || err.message || "Invite failed")
            );
          }
        } finally {
          resetInviteSendUi();
        }
      });
    }
  }

  function initPremiumLoginModal() {
    const modal = document.getElementById("premiumLoginModal");
    const closeBtn = document.getElementById("premiumLoginModalClose");
    const setupBtn = document.getElementById("btnPremiumFromSetup");
    if (closeBtn) closeBtn.addEventListener("click", closePremiumLoginModal);
    if (setupBtn) setupBtn.addEventListener("click", openPremiumLoginModal);
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) closePremiumLoginModal();
      });
    }
  }

  function initLoginPage() {
    const form = document.getElementById("memberLoginForm");
    if (!form) return;

    const params = new URLSearchParams(location.search);
    const onIndex = Boolean(document.getElementById("premiumLoginModal"));
    if (params.get("verified") === "1") {
      const banner = document.getElementById("loginVerifiedBanner");
      if (banner) {
        banner.hidden = false;
        banner.className = "status-line ok";
        banner.textContent = "E-Mail bestätigt — melde dich im Startfenster an.";
      }
    }
    if (onIndex && (params.get("premium") === "1" || location.hash === "#premium")) {
      if (isLoggedIn()) {
        enterAppAfterAuth({ showProfile: params.get("onboard") === "1" });
      } else if (params.get("premium") === "1" || location.hash === "#premium") {
        openPremiumLoginModal();
      }
    }

    const resendPanel = document.getElementById("loginResendPanel");
    const resendBtn = document.getElementById("loginResendBtn");
    const resendStatus = document.getElementById("loginResendStatus");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const user = document.getElementById("loginUsername");
      const pass = document.getElementById("loginPassword");
      const errEl = document.getElementById("loginError");
      if (resendPanel) resendPanel.hidden = true;
      try {
        await login(user?.value, pass?.value);
        if (document.getElementById("premiumLoginModal")) {
          enterAppAfterAuth({ showProfile: true });
        } else {
          window.location.href = "index.html?onboard=1";
        }
      } catch (err) {
        if (errEl) {
          errEl.hidden = false;
          if (err.code === "invalid_credentials") {
            errEl.textContent = "Benutzername oder Passwort ungültig.";
          } else if (err.code === "email_not_verified") {
            errEl.textContent =
              err.message || "Bitte bestätige zuerst deine E-Mail (Link in der Registrierungs-Mail).";
            if (resendPanel) resendPanel.hidden = false;
          } else {
            errEl.textContent = err.message;
          }
        }
      }
    });

    if (resendBtn) {
      resendBtn.addEventListener("click", async () => {
        const user = document.getElementById("loginUsername");
        const pass = document.getElementById("loginPassword");
        if (resendStatus) {
          resendStatus.className = "status-line";
          resendStatus.textContent = "Sende …";
          resendStatus.hidden = false;
        }
        try {
          const result = await resendVerification(user?.value, pass?.value);
          if (resendStatus) {
            resendStatus.className = "status-line ok";
            resendStatus.textContent = result.message || "E-Mail gesendet.";
            if (result.devVerifyUrl) {
              const a = document.createElement("a");
              a.href = result.devVerifyUrl;
              a.textContent = result.devVerifyUrl;
              resendStatus.appendChild(document.createElement("br"));
              resendStatus.appendChild(a);
            }
          }
        } catch (err) {
          if (resendStatus) {
            resendStatus.className = "status-line err";
            resendStatus.textContent = err.message || "Senden fehlgeschlagen.";
          }
        }
      });
    }
  }

  function initVerifyEmailPage() {
    const statusEl = document.getElementById("verifyStatus");
    const hintEl = document.getElementById("verifyHint");
    const loginLink = document.getElementById("verifyLoginLink");
    if (!statusEl) return;

    const token = new URLSearchParams(location.search).get("token") || "";
    if (!token) {
      statusEl.className = "status-line err";
      statusEl.textContent = "Kein Bestätigungs-Token in der URL.";
      return;
    }

    verifyEmail(token)
      .then((data) => {
        statusEl.className = "status-line ok";
        statusEl.textContent = data.message || "E-Mail bestätigt.";
        if (hintEl) {
          hintEl.hidden = false;
          hintEl.textContent = data.username
            ? `Konto „${data.username}“ ist aktiv.`
            : "Du kannst dich jetzt anmelden.";
        }
        if (loginLink) {
          loginLink.hidden = false;
          loginLink.href = "index.html?onboard=1";
          loginLink.textContent = "Zur App / Anmelden";
        }
      })
      .catch((err) => {
        statusEl.className = "status-line err";
        const map = {
          verify_not_found: "Link ungültig oder bereits verwendet.",
          verify_expired: "Link abgelaufen — Premium-Anmeldung, dort Bestätigung erneut senden.",
        };
        statusEl.textContent = map[err.code] || err.message || "Bestätigung fehlgeschlagen.";
        if (loginLink) {
          loginLink.hidden = false;
          loginLink.href = "index.html?onboard=1";
          loginLink.textContent = "Zur App / Anmelden";
        }
      });
  }

  function initRegisterPage() {
    const form = document.getElementById("registerForm");
    if (!form) return;

    const apiBanner = document.getElementById("registerApiStatus");
    checkApiHealth().then((health) => {
      if (!apiBanner) return;
      const base = health.base || resolveApiBase();
      if (health.ok) {
        apiBanner.hidden = true;
        apiBanner.textContent = "";
        return;
      }
      apiBanner.hidden = false;
      apiBanner.className = "status-line err";
      apiBanner.textContent = `${apiUnreachableMessage(base)} — API: ${base || "none"}`;
    });

    const params = new URLSearchParams(location.search);
    const token = params.get("token") || "";
    const tokenInput = document.getElementById("registerInviteToken");
    const inviteInfo = document.getElementById("registerInviteInfo");
    const emailEl = document.getElementById("registerEmail");
    const emailHint = document.getElementById("registerEmailHint");
    const codeRow = document.getElementById("registerInviteCodeRow");
    const successPanel = document.getElementById("registerSuccessPanel");
    if (tokenInput instanceof HTMLInputElement) tokenInput.value = token;

    if (token) {
      if (codeRow) codeRow.hidden = true;
      validateInviteToken(token)
        .then((data) => {
          if (inviteInfo) {
            inviteInfo.textContent = `Invited by ${data.hostName} — please register with your email address.`;
            inviteInfo.className = "status-line ok";
          }
          if (emailEl instanceof HTMLInputElement) {
            emailEl.value = data.email || "";
            emailEl.readOnly = false;
          }
          if (emailHint) {
            emailHint.textContent =
              "Pre-filled from your invitation. Feel free to use a different address for your account.";
          }
        })
        .catch(() => {
          if (inviteInfo) {
            inviteInfo.textContent = "Invitation link invalid or expired.";
            inviteInfo.className = "status-line err";
          }
        });
    } else if (inviteInfo) {
      inviteInfo.textContent =
        "Register using the invitation link in your email or with the 4-digit code from the invitation.";
      inviteInfo.className = "status-line";
      if (emailHint) {
        emailHint.textContent = "For code invites: use the same email as on the invitation.";
      }
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = document.getElementById("registerError");
      try {
        const result = await register({
          inviteToken: tokenInput?.value || token,
          inviteCode: document.getElementById("registerInviteCode")?.value?.trim(),
          email: document.getElementById("registerEmail")?.value,
          username: document.getElementById("registerUsername")?.value,
          password: document.getElementById("registerPassword")?.value,
        });
        form.hidden = true;
        if (successPanel) successPanel.hidden = false;
        const successMsg = document.getElementById("registerSuccessMessage");
        if (successMsg) {
          successMsg.textContent = result.message || "Account created.";
        }
        const username = document.getElementById("registerUsername")?.value;
        const password = document.getElementById("registerPassword")?.value;
        if (result.token && result.user) {
          setSession(result.token, result.user);
          cacheProfile(userToProfile(result.user));
          window.location.href = "index.html?onboard=1";
          return;
        } else if (result.needsEmailVerification) {
          const devEl = document.getElementById("registerDevVerify");
          const successEmailHint = document.getElementById("registerSuccessEmailHint");
          if (successEmailHint) {
            successEmailHint.hidden = false;
            successEmailHint.className = "status-line";
            successEmailHint.textContent = result.emailSent
              ? "No email? Check spam — or use the confirmation link below."
              : "Email delivery is not active — open the confirmation link below.";
          }
          if (devEl && result.devVerifyUrl) {
            devEl.hidden = false;
            devEl.className = "status-line ok";
            devEl.innerHTML = `Confirm: <a href="${result.devVerifyUrl}">Verify email now</a> — then <a href="index.html">log in</a>`;
          }
          if (successMsg && !result.devVerifyUrl) {
            successMsg.textContent += " Then log in on the home page.";
          }
        } else if (username && password) {
          try {
            await login(username, password);
            window.location.href = "index.html?onboard=1";
          } catch (_) {
            window.location.href = "index.html";
          }
        } else {
          window.location.href = "index.html";
        }
      } catch (err) {
        if (errEl) {
          errEl.hidden = false;
          const map = {
            username_taken: "Username already taken.",
            email_taken: "Email already registered.",
            email_mismatch: "Email does not match the invitation.",
            invalid_invite: "Invitation invalid or expired.",
            invite_required: "Invitation required: use the link from the email or a 4-digit code.",
            invalid_invite_code: "Invitation code must be 4 digits.",
            invalid_username: "Username: 3–24 characters (letters, numbers, _).",
            invalid_password: "Password must be at least 8 characters.",
            invalid_email: "Please enter a valid email address.",
          };
          const extra = {
            network_error: apiUnreachableMessage(resolveApiBase()),
            api_not_configured: apiUnreachableMessage(""),
          };
          errEl.textContent = map[err.code] || extra[err.code] || err.message;
        }
      }
    });
  }

  function initWelcomeRedirect() {
    if (!document.body.classList.contains("welcome-page")) return;
    const target = isLoggedIn() ? "index.html?onboard=1" : "index.html";
    window.location.replace(target);
  }

  function initSiteAccessGate() {
    const form = document.getElementById("siteAccessForm");
    if (!form) return;

    const usernameEl = document.getElementById("accessUsername");
    const passwordEl = document.getElementById("accessPassword");
    const errEl = document.getElementById("accessError");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("accessUnlock");
      if (btn instanceof HTMLButtonElement) {
        btn.disabled = true;
        btn.textContent = "Signing in …";
      }
      if (errEl) errEl.hidden = true;

      try {
        await login(usernameEl?.value, passwordEl?.value);
        enterAppAfterAuth({ showProfile: true });
      } catch (err) {
        console.warn("[auth] Login failed:", err.code || err.message);
        if (errEl) {
          errEl.hidden = false;
          const map = {
            invalid_credentials: "Invalid username or password.",
            email_not_verified:
              "Email not verified yet — open the link in your registration email.",
            network_error: apiUnreachableMessage(resolveApiBase()),
            api_not_configured: apiUnreachableMessage(""),
          };
          errEl.textContent = map[err.code] || err.message || "Sign-in failed.";
        }
        if (passwordEl instanceof HTMLInputElement) passwordEl.value = "";
        passwordEl?.focus();
      } finally {
        if (btn instanceof HTMLButtonElement) {
          btn.disabled = false;
          btn.textContent = "Sign in";
        }
      }
    });
  }

  async function bootstrap() {
    updateAccountMenuAuthState();
    let hasSiteAccess = false;
    const tokenAtStart = getSession()?.token;
    if (tokenAtStart) {
      try {
        await fetchProfile();
        if (getSession()?.token === tokenAtStart) hasSiteAccess = true;
      } catch (_) {
        if (getSession()?.token === tokenAtStart) clearSession();
      }
    }
    if (hasSiteAccess) {
      if (global.dualPeerSiteAccess?.grant) global.dualPeerSiteAccess.grant();
      else global.dispatchEvent(new CustomEvent("dualpeer-site-access-granted"));
      const onboard = new URLSearchParams(location.search).get("onboard") === "1";
      if (onboard) {
        queueMicrotask(() => {
          if (global.MemberProfile?.enterProfileWorkspace) {
            global.MemberProfile.enterProfileWorkspace({ onboarding: true });
          } else {
            global.dispatchEvent(
              new CustomEvent("dualpeer-enter-profile", { detail: { onboarding: true } })
            );
          }
          stripAuthQueryParams();
        });
      }
    } else {
      global.dispatchEvent(new CustomEvent("dualpeer-site-access-revoked"));
    }
    readyResolve();
  }

  function onReady(fn) {
    readyPromise.then(fn);
  }

  global.addEventListener("dualpeer-logout-request", () => {
    logout();
  });

  global.addEventListener("dualpeer-session-role", () => {
    updateAccountMenuAuthState();
    const modal = document.getElementById("inviteModal");
    if (modal && !modal.hidden && isSessionGuest()) {
      modal.hidden = true;
    }
  });

  function init() {
    initSiteAccessGate();
    initPremiumLoginModal();
    initInviteModal();
    initLoginPage();
    initWelcomeRedirect();
    initRegisterPage();
    initVerifyEmailPage();
    initProfileMailForm();
    bootstrap();
  }

  global.DualPeerAuth = {
    PRESET_TECHNIQUES,
    resolveApiBase,
    isLoggedIn,
    getSession,
    getCachedProfile,
    login,
    register,
    resendVerification,
    verifyEmail,
    logout,
    fetchProfile,
    updateProfile,
    sendInvite,
    validateInviteToken,
    fetchMailSettings,
    saveMailSettings,
    testMailSettings,
    loadProfileMailSettings,
    openMailSettingsModal,
    closeMailSettingsModal,
    enterAppAfterAuth,
    goToWelcomePage,
    openPremiumLoginModal,
    closePremiumLoginModal,
    onReady,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
