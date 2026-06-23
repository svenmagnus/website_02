/**
 * Member accounts — login, register (invite + email verify), profile API.
 */
(function (global) {
  const SESSION_KEY = "dualpeer-member-session";
  const PROFILE_CACHE_KEY = "dualpeer-member-profile-cache";
  const RENEWAL_REQUIRED_KEY = "dualpeer-renewal-required";

  const PRESET_TECHNIQUES = global.DualPeerTechniques?.allPresets?.() || [];

  let readyResolve;
  const readyPromise = new Promise((r) => {
    readyResolve = r;
  });

  function isTangentClubSite() {
    return /(^|\.)tangent-club\.com$/i.test(location.hostname);
  }

  function resolveAssetUrl(path) {
    if (!path) return "";
    if (/^https?:\/\//i.test(path)) return path;
    const base = resolveApiBase();
    return base ? `${base}${path}` : path;
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
    clearSubscriptionRenewalRequired();
    updateAccountMenuAuthState();
    global.dispatchEvent(new CustomEvent("dualpeer-auth-change", { detail: { loggedIn: false } }));
  }

  function userToProfile(user) {
    if (!user) return null;
    return {
      id: user.id,
      displayName: user.displayName || user.username || "Guest",
      gender: user.gender || "",
      bio: user.bio || "",
      lovenseToys: user.lovenseToys || "",
      nationality: user.nationality || "",
      languages: user.languages || "",
      location: user.location || "",
      techniques: user.techniques || [],
      customTechniques: user.customTechniques || [],
      customMenus: user.customMenus || [],
      enabledCustomMenus: user.enabledCustomMenus || [],
      playPrefs: user.playPrefs || { dynamics: [], kinks: [], intensity: [] },
      username: user.username,
      accountType: user.accountType === "host" ? "host" : "guest",
      isAdmin: Boolean(user.isAdmin),
      isPremium: Boolean(user.isPremium),
      isModel: Boolean(user.isModel),
      isFreeGuest: Boolean(user.isFreeGuest),
      membershipLabel: user.membershipLabel || "",
      membershipType: user.membershipType || user.subscription?.membershipType || "",
      avatarUrl: user.avatarUrl || null,
      isBanned: Boolean(user.isBanned),
      banReason: user.banReason || "",
      bannedAt: user.bannedAt || null,
      appearanceTheme: user.appearanceTheme || "neon",
      subscription: user.subscription || null,
    };
  }

  function isSubscriptionBlocked(profile) {
    if (!profile) return false;
    if (profile.isAdmin) return false;
    const sub = profile?.subscription;
    if (!sub) return false;
    if (sub.exempt) return false;
    if (sub.adminOverride === "trial_expired") return true;
    return Boolean(sub.enforced && !sub.accessGranted);
  }

  function isSubscriptionRenewalDue(sub) {
    if (!sub) return false;
    if (sub.adminOverride === "trial_expired") return true;
    return Boolean(sub.requiresPayment || sub.phase === "trial_expired");
  }

  function subscriptionRenewalUrl() {
    return "continue-subscription.html";
  }

  function isContinueSubscriptionPage() {
    return document.body.classList.contains("continue-subscription-page");
  }

  function subscriptionCheckoutLabel(sub) {
    if (!sub) return "Subscribe";
    if (isSubscriptionRenewalDue(sub)) return "Continue subscription";
    if (sub.phase === "trial" && sub.daysRemaining > 0) return "Subscribe early";
    return "Subscribe now";
  }

  function markSubscriptionRenewalRequired() {
    try {
      sessionStorage.setItem(RENEWAL_REQUIRED_KEY, "1");
    } catch (_) {
      /* ignore */
    }
  }

  function clearSubscriptionRenewalRequired() {
    try {
      sessionStorage.removeItem(RENEWAL_REQUIRED_KEY);
    } catch (_) {
      /* ignore */
    }
  }

  function isIntentionalAppEntry() {
    const params = new URLSearchParams(location.search);
    if (params.has("billing")) return true;
    if (params.get("onboard") === "1") return true;
    if (params.get("premium") === "1") return true;
    if (location.hash === "#premium") return true;
    try {
      return sessionStorage.getItem(RENEWAL_REQUIRED_KEY) === "1";
    } catch (_) {
      return false;
    }
  }

  function isAppIndexPath() {
    const path = location.pathname;
    return path.endsWith("/index.html") || path.endsWith("/") || /\/website_02\/?$/.test(path);
  }

  function maybeRedirectSubscriptionRenewal(profile) {
    if (!profile || profile.isAdmin) return false;
    if (!isSubscriptionBlocked(profile) || isContinueSubscriptionPage()) return false;

    if (isAppIndexPath() && !isIntentionalAppEntry()) {
      location.replace("landing.html");
      return true;
    }

    if (isIntentionalAppEntry()) {
      location.replace(subscriptionRenewalUrl());
      return true;
    }

    return false;
  }

  /** Display role for header, account menu, and admin table. */
  function resolveAccountRoleLabel(user) {
    if (!user) return "Visitor";
    if (user.membershipLabel) return user.membershipLabel;
    if (user.isAdmin) return "Administrator";
    if (user.isModel) return "Premium Partner";
    if (user.isFreeGuest) return "Free";
    const sub = user.subscription;
    if (sub?.membershipLabel) return sub.membershipLabel;
    if (sub?.membershipType === "test" || sub?.phase === "trial") return "Test account";
    if (sub?.membershipType === "expired" || sub?.phase === "trial_expired") return "Membership expired";
    if (user.isPremium || sub?.tier === "premium" || sub?.membershipType === "premium") return "Premium";
    return "Member";
  }

  function resolveAccountRoleBadgeClass(user) {
    if (!user) return "is-visitor";
    const type = user.membershipType || user.subscription?.membershipType;
    if (user.isAdmin || type === "admin") return "is-admin";
    if (user.isModel || type === "partner") return "is-premium-partner";
    if (type === "test") return "is-member";
    if (type === "free" || user.isFreeGuest) return "is-member";
    if (type === "expired" || user.subscription?.phase === "trial_expired") return "is-expired";
    if (user.isPremium || type === "premium" || user.subscription?.tier === "premium") return "is-premium";
    return "is-member";
  }

  const ADMIN_BILLING_TEST_USERNAME = "mr_x";

  function isAdminBillingTestUser(user) {
    return String(user?.username || "").trim().toLowerCase() === ADMIN_BILLING_TEST_USERNAME;
  }

  function isFreeMembershipUser(user) {
    return Boolean(user?.isFreeGuest);
  }

  function hasPremiumModelAccess(user) {
    if (!user) return false;
    if (user.isAdmin) return true;
    if (user.isModel) return false;
    if (user.subscription?.hasPremiumModelAccess) return true;
    return Boolean(user.isPremium) && !user.isModel;
  }

  function resolveAdminUserRoleLabel(user) {
    if (!user) return "Visitor";
    if (user.membershipLabel) return user.membershipLabel;
    if (user.isBanned) return "Banned";
    const override = user.subscriptionOverride || "";
    if (override === "trial_expired") return "Membership expired";
    if (user.isAdmin) return "Administrator";
    if (user.isModel) return "Premium Partner";
    if (override === "active") return "Premium";
    if (override === "member") return "Member";
    if (user.isFreeGuest) return "Free";
    if (user.isPremium) return "Premium";
    if (override === "trial_member") return "Test account";
    return "Member";
  }

  function resolveAdminUserRoleBadgeClass(user) {
    if (!user) return "is-visitor";
    if (user.isBanned) return "is-expired";
    const override = user.subscriptionOverride || "";
    if (override === "trial_expired") return "is-expired";
    return resolveAccountRoleBadgeClass(user);
  }

  function adminRoleBadgeHtml(user) {
    const label = resolveAdminUserRoleLabel(user);
    const cls = resolveAdminUserRoleBadgeClass(user).replace(/^is-/, "admin-status-badge--");
    return `<span class="admin-status-badge ${cls}">${label}</span>`;
  }

  function getAccountUser() {
    return getSession()?.user || null;
  }

  function isAccountHost() {
    const u = getAccountUser();
    return u?.accountType === "host";
  }

  function isAccountGuest() {
    const u = getAccountUser();
    return Boolean(u) && u.accountType !== "host";
  }

  function isAdmin() {
    return Boolean(getAccountUser()?.isAdmin);
  }

  function isPremium() {
    const user = getAccountUser();
    if (!user) return false;
    if (user.isModel) return false;
    return hasPremiumModelAccess(user);
  }

  function syncSessionUserFromProfile(profile) {
    const session = getSession();
    if (!session?.token || !profile) return;
    setSession(session.token, {
      ...session.user,
      username: profile.username ?? session.user?.username,
      displayName: profile.displayName,
      gender: profile.gender ?? session.user?.gender ?? "",
      bio: profile.bio ?? session.user?.bio ?? "",
      lovenseToys: profile.lovenseToys ?? session.user?.lovenseToys ?? "",
      nationality: profile.nationality ?? session.user?.nationality ?? "",
      languages: profile.languages ?? session.user?.languages ?? "",
      location: profile.location ?? session.user?.location ?? "",
      techniques: Array.isArray(profile.techniques) ? profile.techniques : session.user?.techniques || [],
      customTechniques: Array.isArray(profile.customTechniques)
        ? profile.customTechniques
        : session.user?.customTechniques || [],
      customMenus: Array.isArray(profile.customMenus)
        ? profile.customMenus
        : session.user?.customMenus || [],
      enabledCustomMenus: Array.isArray(profile.enabledCustomMenus)
        ? profile.enabledCustomMenus
        : session.user?.enabledCustomMenus || [],
      playPrefs: profile.playPrefs || session.user?.playPrefs || { dynamics: [], kinks: [], intensity: [] },
      accountType: profile.accountType,
      isAdmin: profile.isAdmin,
      isPremium: profile.isPremium,
      isModel: profile.isModel,
      isFreeGuest: profile.isFreeGuest,
      membershipLabel: profile.membershipLabel,
      membershipType: profile.membershipType,
      avatarUrl: profile.avatarUrl ?? session.user?.avatarUrl ?? null,
      isBanned: Boolean(profile.isBanned),
      banReason: profile.banReason || "",
      bannedAt: profile.bannedAt || null,
      subscription: profile.subscription || null,
    });
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

  function redirectToBannedPage({ banReason } = {}) {
    const params = new URLSearchParams();
    const reason = String(banReason || "").trim();
    if (reason) params.set("reason", reason);
    const qs = params.toString();
    window.location.href = qs ? `account-banned.html?${qs}` : "account-banned.html";
  }

  function handleAccountBannedError(err) {
    if (err?.code !== "account_banned") return false;
    clearSession();
    redirectToBannedPage({ banReason: err.data?.banReason || err.message });
    return true;
  }

  function ensureNotBannedProfile(profile) {
    if (!profile?.isBanned) return false;
    clearSession();
    redirectToBannedPage({ banReason: profile.banReason });
    return true;
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
    if (!document.getElementById("appMain")) {
      window.location.href = showProfile ? "index.html?onboard=1" : "index.html";
      return;
    }
    if (!document.getElementById("siteAccessForm")) {
      window.location.href = showProfile ? "index.html?onboard=1" : "index.html";
      return;
    }
    closePremiumLoginModal();
    const profile = getCachedProfile();
    if (isSubscriptionBlocked(profile)) {
      markSubscriptionRenewalRequired();
      window.location.href = subscriptionRenewalUrl();
      return;
    }
    hideSubscriptionOverlay();
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
      if (data.error === "account_banned") {
        clearSession();
      }
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
    const user = userToProfile(data.user) || data.user;
    if (user?.isBanned) {
      const err = new Error("Your account has been banned.");
      err.code = "account_banned";
      err.data = { banReason: user.banReason || "" };
      throw err;
    }
    setSession(data.token, { ...data.user, ...user });
    if (user?.isAdmin) {
      clearSubscriptionRenewalRequired();
    }
    return user;
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

  function parsePasswordResetIdentifier(raw) {
    const value = String(raw ?? "").trim();
    if (!value) return null;
    if (value.includes("@")) return { email: value };
    return { username: value };
  }

  async function requestPasswordReset(identifier) {
    const payload = parsePasswordResetIdentifier(identifier);
    if (!payload) {
      const err = new Error("Enter your email or username.");
      err.code = "identifier_required";
      throw err;
    }
    return api("/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async function validateResetToken(token) {
    return api(`/api/auth/reset-password/${encodeURIComponent(token)}`);
  }

  async function resetPasswordWithToken(token, password) {
    return api("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    });
  }

  async function logout() {
    try {
      if (isLoggedIn()) {
        await api("/api/social/presence/offline", { method: "POST" }).catch(() => {});
        await api("/api/social/sessions/clear", { method: "POST" }).catch(() => {});
        await api("/api/auth/logout", { method: "POST" });
      }
    } catch (_) {
      /* ignore */
    }
    clearSession();
  }

  async function fetchBillingStatus() {
    return api("/api/billing/status");
  }

  async function startBillingCheckout(tier = "member") {
    const data = await api("/api/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ tier }),
    });
    if (data.url) {
      window.location.href = data.url;
      return data;
    }
    throw Object.assign(new Error("checkout_unavailable"), { code: "checkout_unavailable" });
  }

  async function openBillingPortal() {
    const data = await api("/api/billing/portal", { method: "POST" });
    if (data.url) {
      window.location.href = data.url;
      return data;
    }
    throw Object.assign(new Error("portal_unavailable"), { code: "portal_unavailable" });
  }

  function updateSubscriptionOverlay(subscription) {
    const overlay = document.getElementById("subscriptionOverlay");
    if (!overlay || !subscription) return;

    const hint = document.getElementById("subscriptionOverlayHint");
    const trialBanner = document.getElementById("subscriptionTrialBanner");
    const priceAmount = document.getElementById("subscriptionPriceAmount");
    const portalBtn = document.getElementById("subscriptionPortalBtn");
    const checkoutBtn = document.getElementById("subscriptionCheckoutBtn");

    if (priceAmount) priceAmount.textContent = `${subscription.priceEur || "2.95"} €`;

    const renewalDue = isSubscriptionRenewalDue(subscription);

    if (subscription.phase === "trial" && subscription.daysRemaining > 0) {
      if (hint) {
        hint.textContent =
          "Your free trial is still active. You can subscribe early to secure uninterrupted access.";
      }
      if (trialBanner) {
        trialBanner.hidden = false;
        trialBanner.textContent = `${subscription.daysRemaining} day(s) left in your free trial.`;
      }
    } else if (renewalDue) {
      if (hint) {
        hint.textContent =
          "Your free trial has ended. Continue your subscription to restore access to private sessions, chat, and Lovense sync.";
      }
      if (trialBanner) trialBanner.hidden = true;
    } else {
      if (hint) {
        hint.textContent =
          "Your free trial has ended. Subscribe to keep using private sessions, chat, and Lovense sync.";
      }
      if (trialBanner) trialBanner.hidden = true;
    }

    if (portalBtn) {
      portalBtn.hidden = !["active", "trialing", "past_due", "canceled"].includes(subscription.status);
    }
    if (checkoutBtn) {
      checkoutBtn.textContent = subscriptionCheckoutLabel(subscription);
    }

    overlay.hidden = false;
    if (global.dualPeerUi?.openAuthModal) {
      global.dualPeerUi.openAuthModal("subscriptionOverlay");
    }
  }

  function hideSubscriptionOverlay() {
    const overlay = document.getElementById("subscriptionOverlay");
    if (overlay) overlay.hidden = true;
    const errEl = document.getElementById("subscriptionError");
    if (errEl) errEl.hidden = true;
  }

  function formatBillingDate(ts) {
    if (!ts) return "—";
    try {
      return new Date(ts).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch (_) {
      return "—";
    }
  }

  function formatPremiumPrice(sub) {
    if (sub?.premiumBillingMode === "one_time") {
      return `${sub.priceEurPremium || "9.95"} € one-time`;
    }
    return `${sub.priceEurPremium || "9.95"} € / month`;
  }

  function describeSubscriptionForSettings(sub) {
    if (!sub) {
      return {
        badge: "Unknown",
        badgeClass: "muted",
        rows: [],
        note: "",
        showCheckout: false,
        showPortal: false,
      };
    }

    if (!sub.enforced) {
      return {
        badge: "Not required",
        badgeClass: "muted",
        rows: [{ label: "Billing", value: "Platform subscription is not enabled on this server." }],
        note: "",
        showCheckout: false,
        showPortal: false,
      };
    }

    const memberPrice = `${sub.priceEurMember || sub.priceEur || "2.95"} € / month`;
    const premiumPrice = formatPremiumPrice(sub);

    if (sub.membershipType === "free" || sub.phase === "free") {
      return {
        badge: "Free",
        badgeClass: "ok",
        rows: [
          { label: "Account type", value: "Free — admin-granted guest access" },
          { label: "Member plan", value: memberPrice },
          { label: "Premium plan", value: premiumPrice },
        ],
        note: "Special guest access without billing. Upgrade to Premium for Premium Partner bookings.",
        showCheckout: true,
        showPortal: false,
        checkoutLabel: "Upgrade to Premium",
        checkoutTier: "premium",
      };
    }

    if (sub.adminOverride === "trial_member") {
      return {
        badge: "Test account",
        badgeClass: "trial",
        rows: [
          { label: "Status", value: "Test phase active (billing test)" },
          { label: "Days remaining", value: String(sub.daysRemaining ?? 0) },
          { label: "Trial ends", value: formatBillingDate(sub.trialEndsAt) },
          { label: "Member plan", value: memberPrice },
        ],
        note: "Admin billing test — simulates a test account before paid membership.",
        showCheckout: true,
        showPortal: Boolean(sub.stripeCustomerId),
        checkoutLabel: "Subscribe as Member",
        checkoutTier: "member",
      };
    }

    if (sub.adminOverride === "trial_expired") {
      return {
        badge: "Trial ended",
        badgeClass: "warn",
        rows: [
          { label: "Trial ended", value: formatBillingDate(sub.trialEndsAt) },
          { label: "Member plan", value: memberPrice },
          ...(sub.adminOverride === "trial_expired"
            ? [{ label: "Mode", value: "Admin billing test" }]
            : []),
        ],
        note: "Continue your subscription to restore full access to sessions, chat, and invites.",
        showCheckout: true,
        showPortal: Boolean(sub.stripeCustomerId),
        checkoutLabel: "Continue subscription",
        renewalDue: true,
      };
    }

    if (sub.adminOverride === "member") {
      return {
        badge: "Member",
        badgeClass: "ok",
        rows: [
          { label: "Plan", value: memberPrice },
          { label: "Mode", value: "Admin billing test" },
        ],
        note: "Admin override — simulates an active Member subscription.",
        showCheckout: false,
        showPortal: Boolean(sub.stripeCustomerId),
      };
    }

    if (sub.adminOverride === "active") {
      return {
        badge: "Premium",
        badgeClass: "ok",
        rows: [
          { label: "Plan", value: premiumPrice },
          { label: "Mode", value: "Admin billing test" },
        ],
        note: "Admin override — simulates active Premium with Premium Partner access.",
        showCheckout: false,
        showPortal: Boolean(sub.stripeCustomerId),
      };
    }

    if (sub.exempt) {
      return {
        badge: "Included",
        badgeClass: "ok",
        rows: [
          { label: "Plan", value: "Full access — no subscription fee" },
          {
            label: "Reason",
            value: sub.membershipType === "partner" ? "Premium Partner account" : "Administrator account",
          },
        ],
        note: "You are not charged the monthly platform fee.",
        showCheckout: false,
        showPortal: false,
      };
    }

    if (sub.phase === "trial" || sub.membershipType === "test") {
      return {
        badge: "Test account",
        badgeClass: "trial",
        rows: [
          { label: "Status", value: "Test phase active" },
          { label: "Days remaining", value: String(sub.daysRemaining ?? 0) },
          { label: "Test ends", value: formatBillingDate(sub.trialEndsAt) },
          { label: "Member plan", value: memberPrice },
        ],
        note: "Subscribe as Member before the test phase ends to keep access.",
        showCheckout: true,
        showPortal: Boolean(sub.stripeCustomerId),
        checkoutLabel: "Subscribe as Member",
        checkoutTier: "member",
      };
    }

    if (sub.status === "active" || sub.phase === "active") {
      const isPremiumTier = sub.tier === "premium" || sub.membershipType === "premium";
      const planLabel = isPremiumTier ? premiumPrice : memberPrice;
      const isLifetimePremium = sub.status === "lifetime" || sub.premiumBillingMode === "one_time";
      return {
        badge: isPremiumTier ? "Premium" : "Member",
        badgeClass: "ok",
        rows: [
          { label: "Plan", value: planLabel },
          ...(isLifetimePremium
            ? [{ label: "Billing", value: "One-time payment — no renewal" }]
            : [
                { label: "Next renewal", value: formatBillingDate(sub.currentPeriodEnd) },
                {
                  label: "Cancellation",
                  value: sub.cancelAtPeriodEnd
                    ? `Ends ${formatBillingDate(sub.currentPeriodEnd)}`
                    : "Renews automatically",
                },
              ]),
        ],
        note: isPremiumTier
          ? isLifetimePremium
            ? "Premium access is active. Monthly Premium billing can be enabled later when models launch."
            : "Premium includes access to Premium Partners in the Member Pool."
          : "Upgrade to Premium for Premium Partner access.",
        showCheckout: isPremiumTier && !isLifetimePremium ? false : !isPremiumTier,
        showPortal: !isLifetimePremium,
        checkoutLabel: "Upgrade to Premium",
        checkoutTier: "premium",
      };
    }

    if (sub.status === "trialing" || sub.phase === "trialing") {
      const isPremiumTier = sub.tier === "premium";
      const planLabel = isPremiumTier ? premiumPrice : memberPrice;
      return {
        badge: isPremiumTier ? "Premium (trial)" : "Member (trial)",
        badgeClass: "trial",
        rows: [
          { label: "Plan", value: planLabel },
          { label: "Trial ends", value: formatBillingDate(sub.trialEndsAt || sub.currentPeriodEnd) },
          { label: "Days remaining", value: String(sub.daysRemaining ?? 0) },
        ],
        note: "Payment method on file — billing starts when the trial ends unless you cancel.",
        showCheckout: false,
        showPortal: true,
      };
    }

    if (sub.requiresPayment || sub.phase === "trial_expired") {
      return {
        badge: "Membership expired",
        badgeClass: "warn",
        rows: [
          { label: "Test ended", value: formatBillingDate(sub.trialEndsAt) },
          { label: "Member plan", value: memberPrice },
        ],
        note: "Continue as Member to restore full access to sessions, chat, and invites.",
        showCheckout: true,
        showPortal: Boolean(sub.stripeCustomerId),
        checkoutLabel: "Continue as Member",
        checkoutTier: "member",
        renewalDue: true,
      };
    }

    if (sub.status === "past_due") {
      const planLabel = sub.tier === "premium" ? premiumPrice : memberPrice;
      return {
        badge: "Payment issue",
        badgeClass: "err",
        rows: [
          { label: "Plan", value: planLabel },
          { label: "Status", value: "Past due — update your payment method" },
        ],
        note: "Update billing in the customer portal to restore access.",
        showCheckout: false,
        showPortal: true,
      };
    }

    return {
      badge: sub.status === "none" ? "No subscription" : sub.status,
      badgeClass: "muted",
      rows: [
        { label: "Member plan", value: memberPrice },
        { label: "Test ends", value: formatBillingDate(sub.trialEndsAt) },
      ],
      note: "",
      showCheckout: !sub.accessGranted,
      showPortal: Boolean(sub.stripeCustomerId),
      checkoutLabel: "Subscribe as Member",
      checkoutTier: "member",
    };
  }

  function renderSettingsBilling(profile) {
    const section = document.getElementById("settingsBillingSection");
    if (!section) return;

    const badge = document.getElementById("settingsBillingBadge");
    const details = document.getElementById("settingsBillingDetails");
    const noteEl = document.getElementById("settingsBillingNote");
    const checkoutBtn = document.getElementById("settingsBillingCheckoutBtn");
    const portalBtn = document.getElementById("settingsBillingPortalBtn");
    const errEl = document.getElementById("settingsBillingError");
    const intro = document.getElementById("settingsBillingIntro");
    const renewalIntro = document.getElementById("renewalIntro");

    if (!isLoggedIn()) {
      if (intro) {
        intro.innerHTML =
          'Sign in to view your membership status. <a href="login.html">Log in</a>';
      }
      if (renewalIntro) {
        renewalIntro.innerHTML =
          'Sign in to continue your membership. <a href="login.html">Log in</a>';
      }
      if (badge) badge.hidden = true;
      if (details) details.innerHTML = "";
      if (noteEl) noteEl.textContent = "";
      if (checkoutBtn) checkoutBtn.hidden = true;
      if (portalBtn) portalBtn.hidden = true;
      return;
    }

    const sub = profile?.subscription;
    const info = describeSubscriptionForSettings(sub);

    if (intro) {
      intro.textContent =
        "Your platform access — free trial, subscription status, and renewal dates.";
    }

    if (renewalIntro && info.renewalDue) {
      renewalIntro.textContent =
        "Your free trial has ended. Continue your subscription to restore access to private sessions, chat, and Lovense sync.";
    }

    if (badge) {
      badge.hidden = false;
      badge.className = `settings-billing-badge settings-billing-badge--${info.badgeClass}`;
      badge.textContent = info.badge;
    }

    if (details) {
      details.innerHTML = info.rows
        .map(
          (row) =>
            `<div class="settings-billing-detail"><dt>${row.label}</dt><dd>${row.value}</dd></div>`
        )
        .join("");
    }

    if (noteEl) {
      noteEl.textContent = info.note || "";
      noteEl.className = info.note ? "status-line settings-billing-note" : "status-line";
      noteEl.hidden = !info.note;
    }

    if (checkoutBtn instanceof HTMLButtonElement) {
      checkoutBtn.hidden = !info.showCheckout;
      checkoutBtn.textContent = info.checkoutLabel || subscriptionCheckoutLabel(sub);
    }
    if (portalBtn instanceof HTMLButtonElement) {
      portalBtn.hidden = !info.showPortal;
    }
    if (section) section.dataset.checkoutTier = info.checkoutTier || "member";
    if (errEl) errEl.hidden = true;
  }

  async function refreshSettingsBilling() {
    const section = document.getElementById("settingsBillingSection");
    if (!section) return;
    if (!isLoggedIn()) {
      renderSettingsBilling(null);
      return;
    }
    try {
      const profile = getCachedProfile() || (await fetchProfile());
      renderSettingsBilling(profile);
    } catch (err) {
      const errEl = document.getElementById("settingsBillingError");
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = err.message || "Could not load billing status.";
      }
    }
  }

  function initSettingsBillingSection() {
    const section = document.getElementById("settingsBillingSection");
    if (!section) return;

    const checkoutBtn = document.getElementById("settingsBillingCheckoutBtn");
    const portalBtn = document.getElementById("settingsBillingPortalBtn");
    const errEl = document.getElementById("settingsBillingError");

    checkoutBtn?.addEventListener("click", async () => {
      if (checkoutBtn instanceof HTMLButtonElement) {
        checkoutBtn.disabled = true;
      }
      if (errEl) errEl.hidden = true;
      try {
        const tier = section.dataset.checkoutTier || "member";
        await startBillingCheckout(tier);
      } catch (err) {
        if (errEl) {
          errEl.hidden = false;
          errEl.textContent = err.message || "Checkout failed.";
        }
      } finally {
        if (checkoutBtn instanceof HTMLButtonElement) checkoutBtn.disabled = false;
      }
    });

    portalBtn?.addEventListener("click", async () => {
      if (errEl) errEl.hidden = true;
      try {
        await openBillingPortal();
      } catch (err) {
        if (errEl) {
          errEl.hidden = false;
          errEl.textContent = err.message || "Could not open billing portal.";
        }
      }
    });

    onReady(refreshSettingsBilling);
  }

  function initSubscriptionOverlay() {
    const overlay = document.getElementById("subscriptionOverlay");
    if (!overlay) return;

    const checkoutBtn = document.getElementById("subscriptionCheckoutBtn");
    const portalBtn = document.getElementById("subscriptionPortalBtn");
    const logoutBtn = document.getElementById("subscriptionLogoutBtn");
    const errEl = document.getElementById("subscriptionError");

    checkoutBtn?.addEventListener("click", async () => {
      if (checkoutBtn instanceof HTMLButtonElement) {
        checkoutBtn.disabled = true;
        checkoutBtn.textContent = "Opening checkout …";
      }
      if (errEl) errEl.hidden = true;
      try {
        await startBillingCheckout("member");
      } catch (err) {
        if (errEl) {
          errEl.hidden = false;
          errEl.textContent =
            err.code === "stripe_not_configured"
              ? "Billing is not configured yet. Please contact support."
              : err.message || "Checkout failed.";
        }
      } finally {
        if (checkoutBtn instanceof HTMLButtonElement) {
          checkoutBtn.disabled = false;
          const sub = getCachedProfile()?.subscription;
          checkoutBtn.textContent = subscriptionCheckoutLabel(sub);
        }
      }
    });

    portalBtn?.addEventListener("click", async () => {
      if (errEl) errEl.hidden = true;
      try {
        await openBillingPortal();
      } catch (err) {
        if (errEl) {
          errEl.hidden = false;
          errEl.textContent = err.message || "Could not open billing portal.";
        }
      }
    });

    logoutBtn?.addEventListener("click", () => {
      logout();
    });
  }

  function initContinueSubscriptionPage() {
    if (!isContinueSubscriptionPage()) return;

    const logoutFromRenewalPage = async () => {
      await logout();
      location.replace("landing.html");
    };

    ["renewalLogoutBtn", "renewalPageLogoutBtn", "renewalHeaderLogoutBtn"].forEach((id) => {
      document.getElementById(id)?.addEventListener("click", () => {
        logoutFromRenewalPage();
      });
    });

    onReady(async () => {
      if (!isLoggedIn()) {
        location.replace("login.html");
        return;
      }

      const params = new URLSearchParams(location.search);
      if (params.get("billing") === "success") {
        try {
          await fetchProfile();
        } catch (_) {
          /* profile refetch optional */
        }
        const url = new URL(location.href);
        url.searchParams.delete("billing");
        history.replaceState(null, "", url.pathname + url.search + url.hash);
      }

      try {
        const profile = getCachedProfile() || (await fetchProfile());
        if (profile?.isAdmin) {
          clearSubscriptionRenewalRequired();
          location.replace("index.html");
          return;
        }
        if (!isSubscriptionBlocked(profile)) {
          location.replace("index.html");
          return;
        }
        updateAccountMenuAuthState();
        renderSettingsBilling(profile);
      } catch (err) {
        if (handleAccountBannedError(err)) return;
        const errEl = document.getElementById("settingsBillingError");
        if (errEl) {
          errEl.hidden = false;
          errEl.textContent = err.message || "Could not load membership status.";
        }
      }
    });
  }

  function initSettingsPaywallRedirect() {
    if (!document.body.classList.contains("settings-page")) return;
    onReady(async () => {
      if (!isLoggedIn()) return;
      try {
        const profile = getCachedProfile() || (await fetchProfile());
        if (isSubscriptionBlocked(profile)) {
          markSubscriptionRenewalRequired();
          location.replace(subscriptionRenewalUrl());
        }
      } catch (_) {
        /* ignore */
      }
    });
  }

  async function fetchProfile() {
    const data = await api("/api/profile");
    const profile = userToProfile(data.profile);
    if (ensureNotBannedProfile(profile)) return profile;
    cacheProfile(profile);
    syncSessionUserFromProfile(profile);
    if (global.dualPeerUi?.setProfileName) {
      global.dualPeerUi.setProfileName(profile.displayName);
    }
    updateAccountMenuAuthState();
    global.dispatchEvent(new CustomEvent("dualpeer-avatar-ready", { detail: { avatarUrl: profile.avatarUrl } }));
    global.dispatchEvent(new CustomEvent("dualpeer-profile-update", { detail: { profile } }));
    if (document.getElementById("settingsBillingSection")) {
      renderSettingsBilling(profile);
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
    syncSessionUserFromProfile(profile);
    if (global.dualPeerUi?.setProfileName) {
      global.dualPeerUi.setProfileName(profile.displayName);
    }
    updateAccountMenuAuthState();
    global.dispatchEvent(new CustomEvent("dualpeer-profile-update", { detail: { profile } }));
    return profile;
  }

  async function uploadProfileAvatar(imageData) {
    const data = await api("/api/profile/avatar", {
      method: "POST",
      body: JSON.stringify({ imageData }),
    });
    const session = getSession();
    if (session?.user) {
      session.user.avatarUrl = data.avatarUrl || null;
      setSession(session.token, session.user);
    }
    const cached = getCachedProfile();
    if (cached) {
      cached.avatarUrl = data.avatarUrl || null;
      cacheProfile(cached);
    }
    global.dispatchEvent(
      new CustomEvent("dualpeer-profile-update", {
        detail: { profile: { ...cached, avatarUrl: data.avatarUrl } },
      })
    );
    global.dispatchEvent(new CustomEvent("dualpeer-avatar-ready", { detail: { avatarUrl: data.avatarUrl } }));
    return data.avatarUrl;
  }

  async function deleteProfileAvatar() {
    await api("/api/profile/avatar", { method: "DELETE" });
    const session = getSession();
    if (session?.user) {
      session.user.avatarUrl = null;
      setSession(session.token, session.user);
    }
    const cached = getCachedProfile();
    if (cached) {
      cached.avatarUrl = null;
      cacheProfile(cached);
    }
    global.dispatchEvent(
      new CustomEvent("dualpeer-profile-update", { detail: { profile: { ...cached, avatarUrl: null } } })
    );
  }

  async function sendInvite(guestName, email, options = {}) {
    const payload = { guestName };
    const trimmedEmail = String(email || "").trim();
    if (trimmedEmail) payload.email = trimmedEmail;
    const theme =
      global.dualPeerTheme?.read?.() ||
      document.documentElement.getAttribute("data-theme") ||
      "neon";
    payload.appearanceTheme = theme;
    return api("/api/invites", {
      method: "POST",
      body: JSON.stringify(payload),
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

  /** Any signed-in member may invite models into their personal pool. */
  function canManageInvites() {
    return isLoggedIn();
  }

  function canAccessMailSettings() {
    return isLoggedIn() && isAdmin();
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
    if (!canAccessMailSettings()) return;
    if (global.dualPeerUi?.closeAccountMenu) global.dualPeerUi.closeAccountMenu();
    window.location.href = "settings.html#email-server";
  }

  function closeMailSettingsModal() {
    /* SMTP settings live on settings.html — kept for API compatibility. */
  }

  function updateSettingsMailSection() {
    const section = document.getElementById("settingsMailSection");
    if (!section) return;
    const show = canAccessMailSettings();
    section.hidden = !show;
    if (show) loadProfileMailSettings();
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

  async function fetchAdminUsers() {
    return api("/api/admin/users");
  }

  async function updateAdminUser(userId, patch) {
    return api(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch || {}),
    });
  }

  async function createAdminUser(payload) {
    return api("/api/admin/users", {
      method: "POST",
      body: JSON.stringify(payload || {}),
    });
  }

  async function deleteAdminUser(userId) {
    return api(`/api/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
  }

  async function fetchAdminUserProfile(userId) {
    return api(`/api/admin/users/${encodeURIComponent(userId)}/profile`);
  }

  async function fetchPremiumModels() {
    return api("/api/models/premium");
  }

  async function bookModel(payload, options = {}) {
    return api("/api/book-model", {
      method: "POST",
      body: JSON.stringify(payload || {}),
      timeoutMs: 15000,
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
    const inviteMailSetup = document.getElementById("inviteModalMailSetup");

    if (inviteMailSetup) {
      inviteMailSetup.addEventListener("click", () => {
        const inviteModal = document.getElementById("inviteModal");
        if (inviteModal) inviteModal.hidden = true;
        openMailSettingsModal();
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

  function getHeaderRoleLabel() {
    return resolveAccountRoleLabel(getSession()?.user);
  }

  function updateHeaderRoleBadge() {
    const badge = document.getElementById("headerRoleBadge");
    if (!badge) return;
    const user = getSession()?.user;
    const label = resolveAccountRoleLabel(user);
    badge.textContent = label;
    badge.classList.remove(
      "is-host",
      "is-guest",
      "is-admin",
      "is-visitor",
      "is-model",
      "is-member",
      "is-premium",
      "is-premium-partner",
      "is-partner"
    );
    badge.classList.add(resolveAccountRoleBadgeClass(user));
  }

  function updateAccountMenuAuthState() {
    const loggedIn = isLoggedIn();
    const session = getSession();
    const inviteBtn = document.getElementById("btnInviteByEmail");
    const adminUsersBtn = document.getElementById("btnAdminUsers");
    const adminUsersFooterLink = document.getElementById("footerAdminUsersLink");
    const roleEl = document.getElementById("accountRoleLabel") || document.querySelector(".account-role");
    const premiumMenuBtn = document.getElementById("btnPremiumFromMenu");

    if (adminUsersBtn) adminUsersBtn.hidden = !canAccessMailSettings();
    if (adminUsersFooterLink) adminUsersFooterLink.hidden = !canAccessMailSettings();

    if (inviteBtn) {
      const show = canManageInvites();
      inviteBtn.hidden = !show;
      inviteBtn.title = show ? "Send or create an invitation" : "";
    }

    if (roleEl) {
      if (!loggedIn) {
        roleEl.textContent = "Not signed in";
        roleEl.classList.remove("is-host", "is-guest", "is-admin", "is-member", "is-premium", "is-premium-partner", "is-partner");
      } else {
        const user = session?.user;
        roleEl.textContent = resolveAccountRoleLabel(user);
        roleEl.classList.remove("is-host", "is-guest", "is-admin", "is-member", "is-premium", "is-premium-partner", "is-partner", "is-model");
        roleEl.classList.add(resolveAccountRoleBadgeClass(user));
      }
    }

    document.body.classList.toggle("account-host", loggedIn && isAccountHost());
    document.body.classList.toggle("account-guest", loggedIn && isAccountGuest());

    if (premiumMenuBtn) {
      premiumMenuBtn.hidden = !(loggedIn && !isPremium() && !isAccountGuest());
      premiumMenuBtn.title = `Upgrade to Premium (${formatPremiumPrice(getAccountUser()?.subscription)}) — access Premium Partners in the Member Pool.`;
    }

    const inviteMailSetup = document.getElementById("inviteModalMailSetup");
    if (inviteMailSetup) inviteMailSetup.hidden = !canAccessMailSettings();
    const premiumBtn = document.getElementById("headerPremiumBtn");
    if (premiumBtn) premiumBtn.hidden = !isPremium();
    const headerLogoutBtn = document.getElementById("headerLogoutBtn");
    if (headerLogoutBtn) headerLogoutBtn.hidden = !loggedIn;

    updateHeaderRoleBadge();
    updateSettingsMailSection();
    global.dispatchEvent(new CustomEvent("dualpeer-account-role-change"));

    if (loggedIn && session?.user && global.dualPeerUi?.setProfileName) {
      global.dualPeerUi.setProfileName(session.user.displayName || session.user.username);
    }
  }

  function renderInviteShareResult(result, guestName) {
    const box = document.getElementById("inviteShareResult");
    if (!box || !result?.inviteUrl) return;
    const exampleText =
      `Hi ${guestName || ""}! Join me on Tangent Club for a private 1:1 video session.\n` +
      `Tangent Club works with Lovense toys — we can control each other's vibrations remotely during the call.\n` +
      `Register here: ${result.inviteUrl}\n` +
      `Or open tangent-club.com and enter code: ${result.inviteCode || "????"}`;
    box.hidden = false;
    box.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = result.emailSent
      ? "Invite sent — you can also copy link & code:"
      : "Share this invite (link + 4-digit code):";
    box.appendChild(title);
    const linkP = document.createElement("p");
    linkP.innerHTML = `<span class="invite-share-link">${escapeHtml(result.inviteUrl)}</span>`;
    box.appendChild(linkP);
    if (result.inviteCode) {
      const codeP = document.createElement("p");
      codeP.innerHTML = `Code: <span class="invite-share-code">${escapeHtml(result.inviteCode)}</span>`;
      box.appendChild(codeP);
    }
    const example = document.createElement("div");
    example.className = "invite-share-example";
    example.textContent = exampleText;
    box.appendChild(example);
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "secondary invite-copy-btn";
    copyBtn.textContent = "Copy message for Instagram / WhatsApp";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(exampleText);
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
          copyBtn.textContent = "Copy message for Instagram / WhatsApp";
        }, 2000);
      } catch (_) {
        copyBtn.textContent = "Copy failed — select text manually";
      }
    });
    box.appendChild(copyBtn);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  let openInviteModalImpl = null;

  function initInviteModal() {
    const modal = document.getElementById("inviteModal");
    const openBtn = document.getElementById("btnInviteByEmail");
    const closeBtn = document.getElementById("inviteModalClose");
    const sendBtn = document.getElementById("inviteSendBtn");
    const nameInput = document.getElementById("inviteGuestNameInput");
    const emailInput = document.getElementById("inviteEmailInput");
    const status = document.getElementById("inviteModalStatus");
    const shareBox = document.getElementById("inviteShareResult");
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
      if (shareBox) {
        shareBox.hidden = true;
        shareBox.replaceChildren();
      }
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
      if (shareBox) {
        shareBox.hidden = true;
        shareBox.replaceChildren();
      }
      if (nameInput instanceof HTMLInputElement) nameInput.focus();
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
        const guestName = nameInput instanceof HTMLInputElement ? nameInput.value.trim() : "";
        const email = emailInput instanceof HTMLInputElement ? emailInput.value.trim() : "";
        if (!guestName) {
          if (status) {
            status.className = "status-line err";
            status.textContent = "Please enter their name.";
          }
          nameInput?.focus();
          return;
        }
        if (inviteSendAbort) inviteSendAbort.abort();
        inviteSendAbort = new AbortController();
        const signal = inviteSendAbort.signal;
        sendBtn.disabled = true;
        if (status) {
          status.className = "status-line";
          status.textContent = email ? "Sending invitation…" : "Creating invitation…";
        }
        if (shareBox) {
          shareBox.hidden = true;
          shareBox.replaceChildren();
        }
        try {
          const result = await sendInvite(guestName, email, {
            signal,
            timeoutMs: INVITE_SEND_TIMEOUT_MS,
          });
          let msg = "";
          if (result.emailSent) {
            msg = `Invite email sent to ${email}.`;
          } else if (email) {
            msg = result.platformEmailConfigured
              ? "Email could not be sent — copy the link and code below."
              : "Automatic email is not enabled yet — copy the link and code below. You do not need any mail settings in your account.";
          } else {
            msg = "Invitation ready — copy the link and code below (e.g. Instagram DM).";
          }
          if (status) {
            status.className = result.emailSent ? "status-line ok" : "status-line";
            status.textContent = msg;
          }
          const mailSetupBtn = document.getElementById("inviteModalMailSetup");
          if (mailSetupBtn) {
            mailSetupBtn.hidden =
              Boolean(result.emailSent || !email) || !canAccessMailSettings();
          }
          renderInviteShareResult(result, guestName);
          if (emailInput instanceof HTMLInputElement) emailInput.value = "";
        } catch (err) {
          if (err.code === "request_aborted") return;
          if (status) {
            status.className = "status-line err";
            const map = {
              invalid_guest_name: "Please enter their name.",
              invalid_email: "Please enter a valid email address.",
              timeout: "Timed out. Check SMTP settings or try again.",
              smtp_timeout: "SMTP connection timed out. Check port 465 (SSL) or 587.",
              smtp_auth_failed: "SMTP login failed — check mailbox password in Email server settings.",
            };
            status.textContent = map[err.code] || err.message || "Invite failed";
          }
        } finally {
          resetInviteSendUi();
        }
      });
    }

    openInviteModalImpl = open;
    global.addEventListener("dualpeer-open-invite", open);
  }

  function openInviteModal() {
    if (openInviteModalImpl) openInviteModalImpl();
  }

  function initPremiumLoginModal() {
    const modal = document.getElementById("premiumLoginModal");
    const closeBtn = document.getElementById("premiumLoginModalClose");
    const menuBtn = document.getElementById("btnPremiumFromMenu");
    const headerPremiumBtn = document.getElementById("headerPremiumBtn");
    if (closeBtn) closeBtn.addEventListener("click", closePremiumLoginModal);
    if (menuBtn) {
      menuBtn.addEventListener("click", async () => {
        if (global.dualPeerUi?.closeAccountMenu) global.dualPeerUi.closeAccountMenu();
        if (!isLoggedIn()) {
          openPremiumLoginModal();
          return;
        }
        if (isAccountGuest()) return;
        if (isPremium()) {
          location.hash = "premium-modelpool";
          global.MemberProfile?.setRemoteTab?.("modelpool");
          return;
        }
        try {
          await startBillingCheckout("premium");
        } catch (err) {
          console.warn("[auth] premium checkout failed:", err);
        }
      });
    }
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) closePremiumLoginModal();
      });
    }
    if (headerPremiumBtn) {
      headerPremiumBtn.addEventListener("click", () => {
        location.hash = "premium-modelpool";
        global.MemberProfile?.setRemoteTab?.("modelpool");
      });
    }
  }

  function escAdminAttr(value) {
    return String(value || "").replace(/"/g, "&quot;");
  }

  function escAdminHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function adminPlayPrefLabels(ids, options) {
    const map = new Map((options || []).map((o) => [o.id, o.label]));
    return (ids || []).map((id) => map.get(id) || id);
  }

  function adminTechniqueLabels(profile) {
    const builtin = new Map(
      (global.DualPeerTechniques?.allPresets?.() || []).map((t) => [t.id, t.label])
    );
    const custom = new Map((profile.customTechniques || []).map((t) => [t.id, t.label]));
    return (profile.techniques || []).map((id) => custom.get(id) || builtin.get(id) || id);
  }

  function adminGenderLabel(value) {
    if (global.MemberProfile?.genderLabel) return global.MemberProfile.genderLabel(value);
    const map = {
      female: "Female",
      male: "Male",
      nonbinary: "Non-binary",
      other: "Other",
    };
    return map[value] || "Prefer not to say";
  }

  function formatAdminProfileDate(ts) {
    if (!ts) return "—";
    try {
      return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    } catch (_) {
      return "—";
    }
  }

  function renderAdminUserProfileBody(profile) {
    const body = document.getElementById("adminUserProfileBody");
    const title = document.getElementById("adminUserProfileTitle");
    if (!body || !profile) return;
    const PP = global.DualPeerPlayPrefs || {};
    const displayName = profile.displayName || profile.username || "User";
    if (title) title.textContent = `Profile: ${displayName}`;
    const avatarSrc = profile.avatarUrl
      ? global.DualPeerAuth?.resolveAssetUrl?.(profile.avatarUrl) || profile.avatarUrl
      : "";
    const badges = [resolveAccountRoleLabel(profile)];
    if (profile.isBanned) badges.push("Banned");
    const dynamics = adminPlayPrefLabels(profile.playPrefs?.dynamics, PP.DYNAMICS);
    const kinks = adminPlayPrefLabels(profile.playPrefs?.kinks, PP.KINKS);
    const intensity = adminPlayPrefLabels(profile.playPrefs?.intensity, PP.INTENSITY);
    const techniques = adminTechniqueLabels(profile);
    const listHtml = (items) =>
      items.length
        ? `<ul class="admin-profile-tag-list">${items.map((t) => `<li>${escAdminHtml(t)}</li>`).join("")}</ul>`
        : `<p class="admin-profile-empty">—</p>`;
    body.innerHTML = `
      <div class="admin-profile-head">
        ${
          avatarSrc
            ? `<img class="admin-profile-avatar" src="${escAdminAttr(avatarSrc)}" alt="" width="72" height="72" />`
            : `<span class="admin-profile-avatar admin-profile-avatar--initial" aria-hidden="true">${escAdminHtml(displayName.charAt(0).toUpperCase())}</span>`
        }
        <div class="admin-profile-head-meta">
          <p class="admin-profile-display-name">${escAdminHtml(displayName)}</p>
          <p class="admin-profile-username">@${escAdminHtml(profile.username || "")}</p>
          ${
            badges.length
              ? `<p class="admin-profile-badges">${badges.map((b) => `<span class="admin-profile-badge">${escAdminHtml(b)}</span>`).join("")}</p>`
              : ""
          }
        </div>
      </div>
      <dl class="admin-profile-dl">
        <div><dt>Role</dt><dd>${escAdminHtml(resolveAccountRoleLabel(profile))}</dd></div>
        <div><dt>Email</dt><dd>${escAdminHtml(profile.email || "—")}${profile.emailVerified ? " ✓ verified" : ""}</dd></div>
        <div><dt>Gender</dt><dd>${escAdminHtml(adminGenderLabel(profile.gender))}</dd></div>
        <div><dt>Nationality</dt><dd>${escAdminHtml(profile.nationality || "—")}</dd></div>
        <div><dt>Languages</dt><dd>${escAdminHtml(profile.languages || "—")}</dd></div>
        <div><dt>Location</dt><dd>${escAdminHtml(profile.location || "—")}</dd></div>
        <div><dt>Member since</dt><dd>${escAdminHtml(formatAdminProfileDate(profile.createdAt))}</dd></div>
        ${
          profile.isBanned
            ? `<div><dt>Ban reason</dt><dd>${escAdminHtml(profile.banReason || "—")}</dd></div>`
            : ""
        }
      </dl>
      <section class="admin-profile-section">
        <h3>Bio</h3>
        <p class="admin-profile-bio">${escAdminHtml(profile.bio || "—")}</p>
      </section>
      <section class="admin-profile-section">
        <h3>Play preferences</h3>
        <dl class="admin-profile-dl admin-profile-dl--compact">
          <div><dt>Dynamics</dt><dd>${escAdminHtml(dynamics.join(", ") || "—")}</dd></div>
          <div><dt>Kinks</dt><dd>${escAdminHtml(kinks.join(", ") || "—")}</dd></div>
          <div><dt>Intensity</dt><dd>${escAdminHtml(intensity.join(", ") || "—")}</dd></div>
        </dl>
      </section>
      <section class="admin-profile-section">
        <h3>Playbook techniques</h3>
        ${listHtml(techniques)}
      </section>
      <section class="admin-profile-section">
        <h3>Lovense toys</h3>
        <p class="admin-profile-bio">${escAdminHtml(profile.lovenseToys || "—")}</p>
      </section>
    `;
  }

  function openAdminUserProfileModal() {
    const modal = document.getElementById("adminUserProfileModal");
    if (!modal) return;
    modal.hidden = false;
    modal.removeAttribute("aria-hidden");
  }

  function closeAdminUserProfileModal() {
    const modal = document.getElementById("adminUserProfileModal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }

  async function showAdminUserProfile(userId) {
    const body = document.getElementById("adminUserProfileBody");
    const status = document.getElementById("adminUserProfileStatus");
    if (!body) return;
    if (status) {
      status.className = "status-line";
      status.textContent = "Loading profile…";
    }
    body.innerHTML = "";
    openAdminUserProfileModal();
    try {
      const data = await fetchAdminUserProfile(userId);
      renderAdminUserProfileBody(data.profile);
      if (status) {
        status.textContent = "";
        status.className = "status-line";
      }
    } catch (err) {
      if (status) {
        status.textContent = err.message || "Could not load profile.";
        status.className = "status-line err";
      }
    }
  }

  function adminFlagCell(field, checked, { disabled = false } = {}) {
    const labels = {
      isFreeMembership: "Free account",
      isModel: "Premium Partner",
      isAdmin: "Admin",
      isBanned: "Banned",
    };
    const dis = disabled ? " disabled" : "";
    const chk = checked ? " checked" : "";
    const label = labels[field] || field;
    return `<td class="admin-flag-cell"><label class="admin-flag-toggle" title="${label}"><input type="checkbox" class="admin-flag-input" data-field="${field}"${chk}${dis} aria-label="${label}" /><span class="admin-flag-mark" aria-hidden="true"></span></label></td>`;
  }

  function adminBillingOverrideCell(user) {
    if (!isAdminBillingTestUser(user)) {
      return `<td class="admin-billing-cell admin-billing-cell--na" title="Billing test is only available for Mr_X">—</td>`;
    }
    const value = user.subscriptionOverride || "trial_member";
    return `<td class="admin-billing-cell">
      <select class="admin-input admin-billing-override" data-field="subscriptionOverride" title="Simulate billing state for Mr_X test account">
        <option value="trial_member"${value === "trial_member" ? " selected" : ""}>Test account</option>
        <option value="member"${value === "member" ? " selected" : ""}>Member (2.95 €)</option>
        <option value="active"${value === "active" ? " selected" : ""}>Premium (9.95 € one-time)</option>
        <option value="trial_expired"${value === "trial_expired" ? " selected" : ""}>Trial expired</option>
      </select>
    </td>`;
  }

  function buildAdminUserRow(user) {
    const tr = document.createElement("tr");
    tr.dataset.userId = user.id;
    tr.dataset.accountType = user.accountType === "host" ? "host" : "guest";
    if (user.isBanned) tr.classList.add("is-banned-user");
    tr.innerHTML = `
      <td class="admin-user-name-cell"><strong class="admin-user-name" title="Double-click to view full profile">${escAdminAttr(user.username)}</strong></td>
      <td class="admin-status-cell">
        ${adminRoleBadgeHtml(user)}
      </td>
      ${adminFlagCell("isFreeMembership", isFreeMembershipUser(user), {
        disabled: user.isAdmin || user.isModel,
      })}
      <td><input type="email" class="admin-input" data-field="email" value="${escAdminAttr(user.email)}" /></td>
      <td><input type="text" class="admin-input" data-field="displayName" maxlength="32" value="${escAdminAttr(user.displayName)}" /></td>
      <td><input type="text" class="admin-input" data-field="nationality" maxlength="64" value="${escAdminAttr(user.nationality)}" /></td>
      <td><input type="text" class="admin-input" data-field="languages" maxlength="120" value="${escAdminAttr(user.languages)}" /></td>
      <td><input type="text" class="admin-input" data-field="location" maxlength="120" value="${escAdminAttr(user.location)}" /></td>
      ${adminFlagCell("isModel", user.isModel)}
      ${adminFlagCell("isAdmin", user.isAdmin)}
      <td><input type="text" class="admin-input admin-ban-reason-input" data-field="banReason" maxlength="500" placeholder="ban reason (optional)" value="${escAdminAttr(user.banReason)}" /></td>
      ${adminFlagCell("isBanned", user.isBanned)}
      <td><input type="password" class="admin-input" data-field="password" placeholder="new password (optional)" minlength="8" autocomplete="new-password" /></td>
      ${adminBillingOverrideCell(user)}
      <td class="admin-actions-cell">
        <button type="button" class="primary admin-save-btn">Save</button>
        <button type="button" class="secondary admin-pool-btn" title="Add to your model pool">Pool</button>
        <button type="button" class="admin-delete-btn">Delete</button>
      </td>
    `;
    return tr;
  }

  function initAdminUsersModal() {
    const modal = document.getElementById("adminUsersModal");
    const openBtn = document.getElementById("btnAdminUsers");
    const closeBtn = document.getElementById("adminUsersModalClose");
    const refreshBtn = document.getElementById("adminUsersRefreshBtn");
    const createBtn = document.getElementById("adminUsersCreateBtn");
    const status = document.getElementById("adminUsersStatus");
    const tbody = document.getElementById("adminUsersTbody");
    const footerAdminLink = document.getElementById("footerAdminUsersLink");
    if (!modal || !tbody) return;

    const setStatus = (msg, cls = "") => {
      if (!status) return;
      status.className = cls ? `status-line ${cls}` : "status-line";
      status.textContent = msg || "";
    };

    const load = async () => {
      if (!canAccessMailSettings()) return;
      setStatus("Loading profiles…");
      try {
        const data = await fetchAdminUsers();
        tbody.innerHTML = "";
        (data.users || []).forEach((u) => {
          tbody.appendChild(buildAdminUserRow(u));
        });
        setStatus(`${(data.users || []).length} profiles loaded.`, "ok");
      } catch (err) {
        setStatus(err.message || "Failed to load profiles.", "err");
      }
    };

    const open = async () => {
      if (!canAccessMailSettings()) return;
      if (global.dualPeerUi?.openAuthModal) global.dualPeerUi.openAuthModal("adminUsersModal");
      else modal.hidden = false;
      await load();
    };

    if (openBtn) {
      openBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (global.dualPeerUi?.closeAccountMenu) global.dualPeerUi.closeAccountMenu();
        await open();
      });
    }
    if (footerAdminLink) {
      footerAdminLink.addEventListener("click", async (e) => {
        e.preventDefault();
        await open();
      });
    }
    if (closeBtn) closeBtn.addEventListener("click", () => {
      if (global.dualPeerUi?.closeAuthModals) global.dualPeerUi.closeAuthModals();
      else modal.hidden = true;
    });
    if (refreshBtn) refreshBtn.addEventListener("click", () => load());

    const profileModal = document.getElementById("adminUserProfileModal");
    const profileCloseBtn = document.getElementById("adminUserProfileClose");
    if (profileCloseBtn) profileCloseBtn.addEventListener("click", () => closeAdminUserProfileModal());
    if (profileModal) {
      profileModal.addEventListener("click", (e) => {
        if (e.target === profileModal) closeAdminUserProfileModal();
      });
    }

    tbody.addEventListener("dblclick", async (e) => {
      const nameEl = e.target?.closest?.(".admin-user-name");
      if (!nameEl) return;
      const tr = nameEl.closest("tr");
      const userId = tr?.dataset?.userId;
      if (!userId) return;
      await showAdminUserProfile(userId);
    });

    if (createBtn) {
      createBtn.addEventListener("click", async () => {
        const username = document.getElementById("adminCreateUsername")?.value?.trim();
        const email = document.getElementById("adminCreateEmail")?.value?.trim();
        const password = document.getElementById("adminCreatePassword")?.value || "";
        const accountType = document.getElementById("adminCreateRole")?.value || "guest";
        const isAdminChecked = Boolean(document.getElementById("adminCreateIsAdmin")?.checked);
        const isModelChecked = Boolean(document.getElementById("adminCreateIsModel")?.checked);
        setStatus("Creating user…");
        try {
          await createAdminUser({
            username,
            email,
            password,
            accountType,
            isModel: isModelChecked,
            isAdmin: isAdminChecked,
          });
          setStatus(`Created ${username}.`, "ok");
          document.getElementById("adminCreateUsername").value = "";
          document.getElementById("adminCreateEmail").value = "";
          document.getElementById("adminCreatePassword").value = "";
          document.getElementById("adminCreateIsModel").checked = false;
          await load();
        } catch (err) {
          const map = {
            invalid_user_payload:
              "Username (3–24: letters, numbers, _, -), valid email, password min. 8 characters.",
            username_taken: "Username already taken.",
            email_taken: "Email already registered.",
          };
          setStatus(map[err.code] || err.message || "Create failed.", "err");
        }
      });
    }

    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        if (global.dualPeerUi?.closeAuthModals) global.dualPeerUi.closeAuthModals();
        else modal.hidden = true;
      }
    });

    tbody.addEventListener("click", async (e) => {
      const poolBtn = e.target?.closest?.(".admin-pool-btn");
      if (poolBtn) {
        const tr = poolBtn.closest("tr");
        const username = tr?.querySelector("td strong")?.textContent?.trim();
        if (!username || username === getSession()?.user?.username) return;
        poolBtn.disabled = true;
        setStatus(`Adding ${username} to your pool…`);
        try {
          if (global.DualPeerSocial?.addModelToPool) {
            const data = await global.DualPeerSocial.addModelToPool(username);
            setStatus(
              data.alreadyInPool
                ? `${username} is already in your pool.`
                : `${username} added to your pool (Session with).`,
              "ok"
            );
          } else {
            setStatus("Social module not ready — reload the page.", "err");
          }
        } catch (err) {
          setStatus(err.message || "Could not add to pool.", "err");
        } finally {
          poolBtn.disabled = false;
        }
        return;
      }
      const btn = e.target?.closest?.(".admin-save-btn");
      if (!btn) return;
      const tr = btn.closest("tr");
      if (!tr) return;
      const userId = tr.dataset.userId;
      const emailEl = tr.querySelector('[data-field="email"]');
      const displayNameEl = tr.querySelector('[data-field="displayName"]');
      const isModelEl = tr.querySelector('[data-field="isModel"]');
      const isAdminEl = tr.querySelector('[data-field="isAdmin"]');
      const isBannedEl = tr.querySelector('[data-field="isBanned"]');
      const isFreeMembershipEl = tr.querySelector('[data-field="isFreeMembership"]');
      const username = tr.querySelector(".admin-user-name")?.textContent?.trim() || "";
      const patch = {
        email: emailEl?.value,
        displayName: displayNameEl?.value,
        accountType: tr.dataset.accountType || "guest",
        nationality: tr.querySelector('[data-field="nationality"]')?.value,
        languages: tr.querySelector('[data-field="languages"]')?.value,
        location: tr.querySelector('[data-field="location"]')?.value,
        isModel: Boolean(isModelEl?.checked),
        isAdmin: Boolean(isAdminEl?.checked),
        isFreeMembership: Boolean(isFreeMembershipEl?.checked),
        isBanned: Boolean(isBannedEl?.checked),
        banReason: tr.querySelector('[data-field="banReason"]')?.value || "",
        password: tr.querySelector('[data-field="password"]')?.value || "",
      };
      if (username.toLowerCase() === ADMIN_BILLING_TEST_USERNAME) {
        patch.subscriptionOverride =
          tr.querySelector('[data-field="subscriptionOverride"]')?.value || "trial_member";
      }
      btn.disabled = true;
      setStatus("Saving profile…");
      try {
        const res = await updateAdminUser(userId, patch);
        setStatus(`Saved ${res.user?.username || "profile"}.`, "ok");
        const pwd = tr.querySelector('[data-field="password"]');
        if (pwd) pwd.value = "";
        if (res.user?.username === getSession()?.user?.username) {
          try {
            await fetchProfile();
          } catch (_) {
            /* profile refetch optional */
          }
          const profile = getCachedProfile() || getSession()?.user;
          const nextUser = userToProfile(profile || res.user);
          if (nextUser?.isBanned) {
            handleAccountBannedError({ code: "account_banned", data: { banReason: nextUser.banReason } });
            return;
          }
          setSession(getSession().token, { ...getSession().user, ...nextUser });
          if (isSubscriptionBlocked(profile)) {
            updateSubscriptionOverlay(profile.subscription);
          } else {
            hideSubscriptionOverlay();
          }
        }
      } catch (err) {
        setStatus(err.message || "Save failed.", "err");
      } finally {
        btn.disabled = false;
      }
    });

    tbody.addEventListener("click", async (e) => {
      const btn = e.target?.closest?.(".admin-delete-btn");
      if (!btn) return;
      const tr = btn.closest("tr");
      if (!tr) return;
      const userId = tr.dataset.userId;
      const username = tr.querySelector("td strong")?.textContent || "user";
      if (!confirm(`Delete user ${username}? This cannot be undone.`)) return;
      btn.disabled = true;
      setStatus(`Deleting ${username}…`);
      try {
        await deleteAdminUser(userId);
        tr.remove();
        setStatus(`Deleted ${username}.`, "ok");
      } catch (err) {
        setStatus(err.message || "Delete failed.", "err");
      } finally {
        btn.disabled = false;
      }
    });
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
        const profile = await fetchProfile();
        if (isSubscriptionBlocked(profile)) {
          markSubscriptionRenewalRequired();
          window.location.href = subscriptionRenewalUrl();
          return;
        }
        if (document.getElementById("premiumLoginModal")) {
          enterAppAfterAuth({ showProfile: true });
        } else {
          window.location.href = "index.html?onboard=1";
        }
      } catch (err) {
        if (handleAccountBannedError(err)) return;
        if (errEl) {
          errEl.hidden = false;
          if (err.code === "invalid_credentials") {
            errEl.textContent = "Benutzername oder Passwort ungültig.";
          } else if (err.code === "email_not_verified") {
            errEl.textContent =
              err.message || "Bitte bestätige zuerst deine E-Mail (Link in der Registrierungs-Mail).";
            if (resendPanel) resendPanel.hidden = false;
          } else if (err.code === "account_banned") {
            errEl.textContent = "Your account has been banned.";
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

  function initForgotPasswordPage() {
    const form = document.getElementById("forgotPasswordForm");
    if (!form) return;

    const identifierEl = document.getElementById("forgotIdentifier");
    const errEl = document.getElementById("forgotPasswordError");
    const statusEl = document.getElementById("forgotPasswordStatus");
    const devEl = document.getElementById("forgotPasswordDevLink");
    const submitBtn = document.getElementById("forgotPasswordSubmit");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (errEl) {
        errEl.hidden = true;
        errEl.textContent = "";
      }
      if (statusEl) {
        statusEl.hidden = true;
        statusEl.textContent = "";
        statusEl.className = "status-line";
      }
      if (devEl) {
        devEl.hidden = true;
        devEl.textContent = "";
      }
      if (submitBtn) submitBtn.disabled = true;

      try {
        const result = await requestPasswordReset(identifierEl?.value);
        if (statusEl) {
          statusEl.hidden = false;
          statusEl.className = "status-line ok";
          statusEl.textContent =
            result.message ||
            "If an account exists for that email or username, we sent password reset instructions.";
        }
        if (devEl && result.devResetUrl) {
          devEl.hidden = false;
          devEl.className = "status-line ok";
          devEl.innerHTML = `Dev reset link: <a href="${result.devResetUrl}">${result.devResetUrl}</a>`;
        }
        form.querySelectorAll("input").forEach((input) => {
          input.disabled = true;
        });
        if (submitBtn) submitBtn.hidden = true;
      } catch (err) {
        if (errEl) {
          errEl.hidden = false;
          const map = {
            identifier_required: "Enter your email or username.",
            network_error: apiUnreachableMessage(resolveApiBase()),
            api_not_configured: apiUnreachableMessage(""),
          };
          errEl.textContent = map[err.code] || err.message || "Request failed.";
        }
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  function initResetPasswordPage() {
    const form = document.getElementById("resetPasswordForm");
    const statusEl = document.getElementById("resetPasswordStatus");
    const introEl = document.getElementById("resetPasswordIntro");
    const successEl = document.getElementById("resetPasswordSuccess");
    if (!statusEl) return;

    const token = new URLSearchParams(location.search).get("token") || "";
    if (!token) {
      statusEl.className = "status-line err";
      statusEl.textContent = "No reset token in the link. Request a new one below.";
      return;
    }

    validateResetToken(token)
      .then((data) => {
        if (introEl) {
          introEl.hidden = false;
          introEl.className = "status-line ok";
          introEl.textContent = data.username
            ? `Set a new password for “${data.username}”.`
            : "Set a new password for your account.";
        }
        if (form) form.hidden = false;
        statusEl.textContent = "";
        statusEl.className = "status-line";

        form?.addEventListener("submit", async (e) => {
          e.preventDefault();
          const errEl = document.getElementById("resetPasswordError");
          const submitBtn = document.getElementById("resetPasswordSubmit");
          const newEl = document.getElementById("resetPasswordNew");
          const confirmEl = document.getElementById("resetPasswordConfirm");
          const password = String(newEl?.value || "");
          const confirm = String(confirmEl?.value || "");

          if (errEl) {
            errEl.hidden = true;
            errEl.textContent = "";
          }
          if (password.length < 8) {
            if (errEl) {
              errEl.hidden = false;
              errEl.textContent = "Password must be at least 8 characters.";
            }
            return;
          }
          if (password !== confirm) {
            if (errEl) {
              errEl.hidden = false;
              errEl.textContent = "Passwords do not match.";
            }
            return;
          }
          if (submitBtn) submitBtn.disabled = true;

          try {
            const result = await resetPasswordWithToken(token, password);
            if (form) form.hidden = true;
            if (introEl) introEl.hidden = true;
            statusEl.className = "status-line ok";
            statusEl.textContent = result.message || "Password updated.";
            if (successEl) successEl.hidden = false;
          } catch (err) {
            if (submitBtn) submitBtn.disabled = false;
            const map = {
              reset_not_found: "This reset link is invalid or was already used.",
              reset_expired: "This reset link has expired. Request a new one.",
              invalid_password: "Password must be at least 8 characters.",
              account_banned: "This account has been banned.",
              network_error: apiUnreachableMessage(resolveApiBase()),
              api_not_configured: apiUnreachableMessage(""),
            };
            if (errEl) {
              errEl.hidden = false;
              errEl.textContent = map[err.code] || err.message || "Reset failed.";
            }
          }
        });
      })
      .catch((err) => {
        const map = {
          reset_not_found: "This reset link is invalid or was already used.",
          reset_expired: "This reset link has expired. Request a new one below.",
        };
        statusEl.className = "status-line err";
        statusEl.textContent = map[err.code] || err.message || "Reset link invalid.";
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
    const prefillInviteCode = String(params.get("inviteCode") || "").trim();
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
            inviteInfo.textContent = data.manualInvite
              ? `Invited by ${data.hostName} — register with your own email address.`
              : `Invited by ${data.hostName} — please register with your email address.`;
            inviteInfo.className = "status-line ok";
          }
          if (emailEl instanceof HTMLInputElement) {
            emailEl.value = data.email || "";
            emailEl.readOnly = false;
          }
          if (emailHint) {
            emailHint.textContent = data.manualInvite
              ? "Choose any email address for your new account."
              : "Pre-filled from your invitation. Feel free to use a different address for your account.";
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
        "Your invitation link or code unlocks registration — exclusivity keeps the platform focused on real 1:1 sessions.";
      inviteInfo.className = "status-line";
      if (emailHint) {
        emailHint.textContent = "Use your own email address for your new account.";
      }
      if (/^\d{4}$/.test(prefillInviteCode)) {
        const codeInput = document.getElementById("registerInviteCode");
        if (codeInput instanceof HTMLInputElement) codeInput.value = prefillInviteCode;
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
              ? "Check your inbox for login details (email, password, login link). Also check spam."
              : "Email delivery is not active — open the confirmation link below.";
          }
          if (devEl && result.devVerifyUrl) {
            devEl.hidden = false;
            devEl.className = "status-line ok";
            devEl.innerHTML = `Confirm: <a href="${result.devVerifyUrl}">Verify email now</a> — then <a href="login.html">log in</a>`;
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
            invalid_username: "Username: 3–24 characters (letters, numbers, _, -).",
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
    const target = isLoggedIn() ? "index.html?onboard=1" : "landing.html";
    window.location.replace(target);
  }

  function maybeRedirectToPublicLanding() {
    const path = location.pathname;
    const onIndex =
      path.endsWith("/index.html") || path.endsWith("/") || /\/website_02\/?$/.test(path);
    if (!onIndex) return;
    if (getSession()?.token) return;

    const params = new URLSearchParams(location.search);
    if (params.get("login") === "1") {
      location.replace("login.html");
      return;
    }
    if (params.get("verified") === "1") {
      location.replace("login.html?verified=1");
      return;
    }
    const stayOnIndex = ["premium", "onboard", "calendar"];
    if (stayOnIndex.some((key) => params.has(key))) return;

    const token = params.get("token");
    const inviteCode = params.get("inviteCode");
    if (token || inviteCode) {
      location.replace(`register.html${location.search}`);
      return;
    }
    location.replace("landing.html");
  }

  function initPublicLoginExtras() {
    if (!document.body.classList.contains("login-page")) return;

    const params = new URLSearchParams(location.search);
    if (params.get("token")) {
      location.replace(`register.html?token=${encodeURIComponent(params.get("token") || "")}`);
      return;
    }

    if (params.get("verified") === "1") {
      const banner = document.getElementById("loginPageVerifiedBanner");
      if (banner) {
        banner.hidden = false;
        banner.textContent = "Email verified — sign in with your username and password.";
      }
    }

    const codeEl = document.getElementById("publicInviteCode");
    const continueBtn = document.getElementById("publicInviteContinue");
    const errEl = document.getElementById("publicInviteError");
    const prefill = String(params.get("inviteCode") || "")
      .replace(/\D+/g, "")
      .slice(0, 4);
    if (prefill && codeEl instanceof HTMLInputElement) codeEl.value = prefill;

    const goRegisterWithCode = () => {
      const code = codeEl instanceof HTMLInputElement ? codeEl.value.trim() : "";
      if (!/^\d{4}$/.test(code)) {
        if (errEl) {
          errEl.hidden = false;
          errEl.textContent = "Enter the 4-digit code from your invitation.";
        }
        codeEl?.focus();
        return;
      }
      location.href = `register.html?inviteCode=${encodeURIComponent(code)}`;
    };

    if (codeEl instanceof HTMLInputElement) {
      codeEl.addEventListener("input", () => {
        codeEl.value = codeEl.value.replace(/\D+/g, "").slice(0, 4);
        if (errEl) errEl.hidden = true;
      });
      codeEl.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        goRegisterWithCode();
      });
    }
    continueBtn?.addEventListener("click", goRegisterWithCode);
  }

  function initSiteAccessGate() {
    const form = document.getElementById("siteAccessForm");
    if (!form) return;

    const usernameEl = document.getElementById("accessUsername");
    const passwordEl = document.getElementById("accessPassword");
    const inviteCodeEl = document.getElementById("accessInviteCode");
    const errEl = document.getElementById("accessError");
    const modelHintEl = document.getElementById("accessModelHint");

    const setModelHint = (text, cls = "") => {
      if (!modelHintEl) return;
      modelHintEl.className = cls ? `status-line ${cls}` : "status-line";
      modelHintEl.textContent = text;
    };

    const freeHostBtn = document.getElementById("authModelFreeHost");
    const guestInviteBtn = document.getElementById("authModelGuestInvite");
    const inviteCodeRow = document.getElementById("accessInviteCodeRow");

    const isLoginPage = document.body.classList.contains("login-page");

    const setAccessModelUi = (mode) => {
      if (!inviteCodeRow) return;
      const showInviteCode = mode === "guestInvite";
      inviteCodeRow.hidden = !showInviteCode;
      inviteCodeRow.style.display = showInviteCode ? "flex" : "none";
      if (!showInviteCode && inviteCodeEl instanceof HTMLInputElement) {
        inviteCodeEl.value = "";
      }
    };

    if (!isLoginPage) {
      setAccessModelUi("freeHost");
    }

    if (freeHostBtn) {
      freeHostBtn.addEventListener("click", () => {
        setAccessModelUi("freeHost");
        setModelHint("Member Login: sign in with your account, or register as a new member.");
        usernameEl?.focus();
      });
    }
    if (guestInviteBtn) {
      guestInviteBtn.addEventListener("click", () => {
        setAccessModelUi("guestInvite");
        setModelHint("Guest by Invitation: enter your 4-digit code, then continue to register.");
        inviteCodeEl?.focus();
      });
    }

    if (inviteCodeEl instanceof HTMLInputElement) {
      inviteCodeEl.addEventListener("input", () => {
        inviteCodeEl.value = inviteCodeEl.value.replace(/\D+/g, "").slice(0, 4);
      });
      inviteCodeEl.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const code = inviteCodeEl.value.trim();
        if (!/^\d{4}$/.test(code)) {
          setModelHint("Invite code must be 4 digits.", "err");
          return;
        }
        window.location.href = `register.html?inviteCode=${encodeURIComponent(code)}`;
      });
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("accessUnlock");
      if (btn instanceof HTMLButtonElement) {
        btn.disabled = true;
        btn.textContent = isLoginPage ? "Logging in …" : "Signing in …";
      }
      if (errEl) errEl.hidden = true;

      try {
        if (inviteCodeEl instanceof HTMLInputElement && /^\d{4}$/.test(inviteCodeEl.value.trim())) {
          window.location.href = `register.html?inviteCode=${encodeURIComponent(inviteCodeEl.value.trim())}`;
          return;
        }
        await login(usernameEl?.value, passwordEl?.value);
        if (isLoginPage) {
          let profile = null;
          try {
            profile = await fetchProfile();
          } catch (_) {
            /* profile optional for redirect */
          }
          if (isSubscriptionBlocked(profile)) {
            markSubscriptionRenewalRequired();
            window.location.href = subscriptionRenewalUrl();
          } else {
            window.location.href = "index.html?onboard=1";
          }
          return;
        }
        const profile = await fetchProfile();
        if (isSubscriptionBlocked(profile)) {
          markSubscriptionRenewalRequired();
          window.location.href = subscriptionRenewalUrl();
          return;
        }
        enterAppAfterAuth({ showProfile: true });
      } catch (err) {
        if (handleAccountBannedError(err)) return;
        console.warn("[auth] Login failed:", err.code || err.message);
        if (errEl) {
          errEl.hidden = false;
          const map = {
            invalid_credentials: "Invalid username or password.",
            email_not_verified:
              "Email not verified yet — open the link in your registration email.",
            account_banned: "Your account has been banned.",
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
          btn.textContent = isLoginPage ? "Log in" : "Sign in";
        }
      }
    });
  }

  async function bootstrap() {
    updateAccountMenuAuthState();
    updateSettingsMailSection();
    let hasSiteAccess = false;
    const tokenAtStart = getSession()?.token;
    if (tokenAtStart) {
      try {
        await fetchProfile();
        if (getSession()?.token === tokenAtStart) {
          const profile = getCachedProfile() || getSession()?.user;
          if (ensureNotBannedProfile(profile)) return;
          hasSiteAccess = true;
        }
      } catch (err) {
        if (handleAccountBannedError(err)) return;
        if (getSession()?.token === tokenAtStart) clearSession();
      }
    }
    if (hasSiteAccess) {
      const params = new URLSearchParams(location.search);
      if (params.get("billing") === "success") {
        try {
          await fetchProfile();
        } catch (_) {
          /* profile refetch optional */
        }
        const url = new URL(location.href);
        url.searchParams.delete("billing");
        history.replaceState(null, "", url.pathname + url.search + url.hash);
      }

      const profile = getCachedProfile() || getSession()?.user;
      if (maybeRedirectSubscriptionRenewal(profile)) {
        readyResolve();
        return;
      }
      if (isSubscriptionBlocked(profile)) {
        if (global.dualPeerSiteAccess?.applySubscriptionPaywall) {
          global.dualPeerSiteAccess.applySubscriptionPaywall();
        }
        updateSubscriptionOverlay(profile.subscription);
        global.dispatchEvent(
          new CustomEvent("dualpeer-subscription-required", { detail: profile.subscription })
        );
      } else {
        hideSubscriptionOverlay();
        clearSubscriptionRenewalRequired();
        if (global.dualPeerSiteAccess?.grant) global.dualPeerSiteAccess.grant();
        else global.dispatchEvent(new CustomEvent("dualpeer-site-access-granted"));
        global.dispatchEvent(new CustomEvent("dualpeer-subscription-granted"));
      }

      const onboard = params.get("onboard") === "1";
      if (onboard && !isSubscriptionBlocked(profile)) {
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

  function initPrivilegedSessionAccess() {
    const user = getSession()?.user;
    if (!user) return;
    if (user.isAdmin) {
      clearSubscriptionRenewalRequired();
      hideSubscriptionOverlay();
      if (global.dualPeerSiteAccess?.grant) global.dualPeerSiteAccess.grant();
      else global.dispatchEvent(new CustomEvent("dualpeer-site-access-granted"));
    }
  }

  function init() {
    maybeRedirectToPublicLanding();
    initPrivilegedSessionAccess();
    global.dualPeerUi?.initPasswordToggles?.();
    initSiteAccessGate();
    initPublicLoginExtras();
    initPremiumLoginModal();
    initInviteModal();
    initLoginPage();
    initWelcomeRedirect();
    initRegisterPage();
    initVerifyEmailPage();
    initForgotPasswordPage();
    initResetPasswordPage();
    initProfileMailForm();
    initAdminUsersModal();
    initSubscriptionOverlay();
    initSettingsBillingSection();
    initContinueSubscriptionPage();
    initSettingsPaywallRedirect();
    bootstrap();
  }

  global.DualPeerAuth = {
    PRESET_TECHNIQUES,
    api,
    resolveApiBase,
    resolveAssetUrl,
    isLoggedIn,
    isAccountHost,
    isAccountGuest,
    isAdmin,
    isPremium,
    hasPremiumModelAccess,
    canManageInvites,
    canAccessMailSettings,
    getSession,
    getCachedProfile,
    cacheProfile,
    login,
    register,
    resendVerification,
    verifyEmail,
    requestPasswordReset,
    validateResetToken,
    resetPasswordWithToken,
    logout,
    fetchProfile,
    updateProfile,
    uploadProfileAvatar,
    deleteProfileAvatar,
    sendInvite,
    openInviteModal,
    resolveAccountRoleLabel,
    resolveAccountRoleBadgeClass,
    fetchPremiumModels,
    bookModel,
    fetchBillingStatus,
    startBillingCheckout,
    openBillingPortal,
    refreshSettingsBilling,
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
    isSubscriptionBlocked,
    isSubscriptionRenewalDue,
    subscriptionRenewalUrl,
    subscriptionCheckoutLabel,
    onReady,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
