/**
 * Toggle invite-only vs public-registration copy on static pages.
 * Loads config from GET /api/auth/registration-config (PUBLIC_REGISTRATION env).
 */
(function (global) {
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
    return location.origin;
  }

  async function fetchRegistrationConfig() {
    const base = resolveApiBase();
    if (!base) return { ok: true, publicRegistration: false };
    try {
      const res = await fetch(`${base}/api/auth/registration-config`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return { ok: true, publicRegistration: false };
      return await res.json();
    } catch (_) {
      return { ok: true, publicRegistration: false };
    }
  }

  function applyPublicRegistrationUi(publicRegistration) {
    document.documentElement.classList.toggle("public-registration-open", publicRegistration);
    document.body?.classList.toggle("public-registration-open", publicRegistration);

    document.querySelectorAll("[data-invite-only]").forEach((el) => {
      el.hidden = publicRegistration;
    });
    document.querySelectorAll("[data-public-registration]").forEach((el) => {
      el.hidden = !publicRegistration;
    });

    const meta = document.querySelector('meta[name="description"][data-public-content]');
    if (meta instanceof HTMLMetaElement && publicRegistration) {
      const publicContent = meta.getAttribute("data-public-content");
      if (publicContent) meta.setAttribute("content", publicContent);
    }
  }

  const ready = fetchRegistrationConfig().then((config) => {
    const publicRegistration = Boolean(config?.publicRegistration);
    applyPublicRegistrationUi(publicRegistration);
    return { ...config, publicRegistration };
  });

  function init() {
    void ready;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  global.dualPeerPublicRegistrationUi = {
    ready,
    fetchRegistrationConfig,
    applyPublicRegistrationUi,
  };
})(window);
