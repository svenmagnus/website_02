/**
 * Member accounts — login, register (invite + email verify), profile API.
 */
(function (global) {
  const SESSION_KEY = "dualpeer-member-session";
  const PROFILE_CACHE_KEY = "dualpeer-member-profile-cache";

  const PRESET_TECHNIQUES = [
    { id: "nipple_play", label: "Nipple Play" },
    { id: "spank_ass", label: "Spank Ass" },
    { id: "spank_breast", label: "Spank Breast" },
    { id: "tease_denial", label: "Tease / Denial" },
    { id: "dirty_talk", label: "Dirty Talk" },
    { id: "roleplay", label: "Roleplay" },
  ];

  let readyResolve;
  const readyPromise = new Promise((r) => {
    readyResolve = r;
  });

  function resolveApiBase() {
    if (global.DUALPEER_WHIP_URL) return String(global.DUALPEER_WHIP_URL).replace(/\/$/, "");
    if (location.port === "8787") return location.origin;
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
      return `${location.protocol}//${location.hostname}:8787`;
    }
    if (/(^|\.)tangent-club\.com$/i.test(location.hostname)) {
      const tunnel = global.WHIP_CLOUDFLARE_TUNNEL_URL;
      if (tunnel && /^https:\/\//i.test(tunnel) && !/REPLACE/i.test(tunnel)) {
        return String(tunnel).replace(/\/$/, "");
      }
    }
    return "http://127.0.0.1:8787";
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

  function authHeaders() {
    const token = getSession()?.token;
    return token
      ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
      : { "Content-Type": "application/json" };
  }

  async function api(path, options = {}) {
    const resp = await fetch(`${resolveApiBase()}${path}`, {
      ...options,
      headers: { ...authHeaders(), ...(options.headers || {}) },
    });
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

  async function login(username, password) {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
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

  async function sendInvite(email) {
    return api("/api/invites", {
      method: "POST",
      body: JSON.stringify({ email }),
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

  function updateAccountMenuAuthState() {
    const loggedIn = isLoggedIn();
    const session = getSession();
    const inviteBtn = document.getElementById("btnInviteByEmail");
    const loginLink = document.getElementById("btnMemberLogin");
    const roleEl = document.querySelector(".account-role");

    if (inviteBtn) {
      const show = canManageInvites();
      inviteBtn.hidden = !show;
      inviteBtn.disabled = !show;
      inviteBtn.title = show
        ? "Send email invitation"
        : loggedIn
          ? "Not available while you are connected as guest"
          : "Log in to send invitations";
    }
    if (loginLink) {
      loginLink.hidden = loggedIn;
    }
    if (roleEl) {
      roleEl.textContent = loggedIn ? `@${session?.user?.username || "member"}` : "Guest (local)";
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

    const close = () => {
      if (modal) modal.hidden = true;
    };
    const open = () => {
      if (!isLoggedIn()) {
        window.location.href = "login.html";
        return;
      }
      if (!canManageInvites()) {
        return;
      }
      if (modal) modal.hidden = false;
      if (emailInput instanceof HTMLInputElement) emailInput.focus();
      if (status) status.textContent = "";
    };

    if (openBtn) openBtn.addEventListener("click", open);
    if (closeBtn) closeBtn.addEventListener("click", close);
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) close();
      });
    }
    if (sendBtn) {
      sendBtn.addEventListener("click", async () => {
        const email = emailInput instanceof HTMLInputElement ? emailInput.value.trim() : "";
        if (!email) return;
        sendBtn.disabled = true;
        if (status) {
          status.className = "status-line";
          status.textContent = "Sending…";
        }
        try {
          const result = await sendInvite(email);
          const msg = result.emailSent
            ? `Einladung wurde an ${email} gesendet (Link + Einmalcode in der E-Mail).`
            : "SMTP nicht konfiguriert — Link und Code unten manuell teilen:";
          if (status) {
            status.className = "status-line ok";
            status.textContent = msg;
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
              codeLine.innerHTML = `<strong>Einladungscode:</strong> <code>${result.inviteCode}</code>`;
              status.appendChild(codeLine);
            }
          }
          if (emailInput instanceof HTMLInputElement) emailInput.value = "";
        } catch (err) {
          if (status) {
            status.className = "status-line err";
            status.textContent = err.message || "Invite failed";
          }
        } finally {
          sendBtn.disabled = false;
        }
      });
    }
  }

  function initLoginPage() {
    const form = document.getElementById("memberLoginForm");
    if (!form) return;

    const params = new URLSearchParams(location.search);
    if (params.get("verified") === "1") {
      const banner = document.getElementById("loginVerifiedBanner");
      if (banner) {
        banner.hidden = false;
        banner.className = "status-line ok";
        banner.textContent = "E-Mail bestätigt — du kannst dich jetzt anmelden.";
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
        window.location.href = "index.html";
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
          loginLink.href = "login.html?verified=1";
        }
      })
      .catch((err) => {
        statusEl.className = "status-line err";
        const map = {
          verify_not_found: "Link ungültig oder bereits verwendet.",
          verify_expired: "Link abgelaufen — auf der Anmeldeseite „Bestätigung erneut senden“.",
        };
        statusEl.textContent = map[err.code] || err.message || "Bestätigung fehlgeschlagen.";
        if (loginLink) {
          loginLink.hidden = false;
          loginLink.href = "login.html";
        }
      });
  }

  function initRegisterPage() {
    const form = document.getElementById("registerForm");
    if (!form) return;

    const params = new URLSearchParams(location.search);
    const token = params.get("token") || "";
    const tokenInput = document.getElementById("registerInviteToken");
    const inviteInfo = document.getElementById("registerInviteInfo");
    const emailEl = document.getElementById("registerEmail");
    const emailHint = document.getElementById("registerEmailHint");
    const codeRow = document.getElementById("registerInviteCodeRow");
    const successPanel = document.getElementById("registerSuccessPanel");
    if (tokenInput instanceof HTMLInputElement) tokenInput.value = token;

    const list = document.getElementById("registerTechniqueList");
    if (list) {
      PRESET_TECHNIQUES.forEach((t) => {
        const label = document.createElement("label");
        label.className = "technique-check";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.name = "registerTechnique";
        input.value = t.id;
        const span = document.createElement("span");
        span.textContent = t.label;
        label.appendChild(input);
        label.appendChild(span);
        list.appendChild(label);
      });
    }

    if (token) {
      if (codeRow) codeRow.hidden = true;
      validateInviteToken(token)
        .then((data) => {
          if (inviteInfo) {
            inviteInfo.textContent = `Eingeladen von ${data.hostName} — bitte mit dieser E-Mail registrieren.`;
            inviteInfo.className = "status-line ok";
          }
          if (emailEl instanceof HTMLInputElement) {
            emailEl.value = data.email || "";
            emailEl.readOnly = true;
          }
          if (emailHint) {
            emailHint.textContent = "E-Mail ist durch die Einladung festgelegt.";
          }
        })
        .catch(() => {
          if (inviteInfo) {
            inviteInfo.textContent = "Einladungslink ungültig oder abgelaufen.";
            inviteInfo.className = "status-line err";
          }
        });
    } else if (inviteInfo) {
      inviteInfo.textContent =
        "Ohne Einladungslink: ersten Host-Account anlegen (nur solange noch keine Mitglieder existieren). Alternativ E-Mail + 6-stelligen Code aus der Einladungs-Mail eingeben.";
      inviteInfo.className = "status-line";
      if (emailHint) {
        emailHint.textContent = "Muss mit der E-Mail aus der Einladung übereinstimmen.";
      }
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = document.getElementById("registerError");
      const techniques = [];
      document.querySelectorAll('input[name="registerTechnique"]:checked').forEach((el) => {
        if (el instanceof HTMLInputElement) techniques.push(el.value);
      });
      try {
        const result = await register({
          inviteToken: tokenInput?.value || token,
          inviteCode: document.getElementById("registerInviteCode")?.value,
          email: document.getElementById("registerEmail")?.value,
          username: document.getElementById("registerUsername")?.value,
          password: document.getElementById("registerPassword")?.value,
          displayName: document.getElementById("registerDisplayName")?.value,
          gender: document.getElementById("registerGender")?.value,
          bio: document.getElementById("registerBio")?.value,
          techniques,
          customTechniques: [],
        });
        form.hidden = true;
        if (successPanel) successPanel.hidden = false;
        const successMsg = document.getElementById("registerSuccessMessage");
        if (successMsg) {
          successMsg.textContent = result.message || "Konto erstellt.";
        }
        if (result.needsEmailVerification) {
          const devEl = document.getElementById("registerDevVerify");
          if (devEl && result.devVerifyUrl) {
            devEl.hidden = false;
            devEl.innerHTML = `Dev: <a href="${result.devVerifyUrl}">Bestätigung testen</a>`;
          }
        } else {
          setTimeout(() => {
            window.location.href = "login.html?verified=1";
          }, 1500);
        }
      } catch (err) {
        if (errEl) {
          errEl.hidden = false;
          const map = {
            username_taken: "Benutzername bereits vergeben.",
            email_taken: "E-Mail bereits registriert.",
            email_mismatch: "E-Mail passt nicht zur Einladung.",
            invalid_invite: "Einladung ungültig oder abgelaufen.",
            invite_required: "Einladung oder erster Host-Account erforderlich.",
            invalid_username: "Benutzername: 3–24 Zeichen (Buchstaben, Zahlen, _).",
            invalid_password: "Passwort mindestens 8 Zeichen.",
            invalid_email: "Bitte eine gültige E-Mail-Adresse eingeben.",
          };
          errEl.textContent = map[err.code] || err.message;
        }
      }
    });
  }

  async function bootstrap() {
    updateAccountMenuAuthState();
    if (isLoggedIn()) {
      try {
        await fetchProfile();
      } catch (_) {
        clearSession();
      }
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
    initInviteModal();
    initLoginPage();
    initRegisterPage();
    initVerifyEmailPage();
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
    onReady,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
