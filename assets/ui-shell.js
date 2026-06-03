/**
 * Shared header UI: CB light/dark theme + account dropdown (Chaturbate-style).
 */
(function (global) {
  const THEME_STORAGE_KEY = "dualpeer-theme";
  const PROFILE_NAME_KEY = "dualpeer-profile-name";
  const ALLOWED_THEMES = ["cb-dark", "cb-light"];

  function normalizeTheme(theme) {
    if (theme === "original") return "cb-dark";
    return ALLOWED_THEMES.includes(theme) ? theme : "cb-dark";
  }

  function getSavedTheme() {
    try {
      return normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY) || "cb-dark");
    } catch (_) {
      return "cb-dark";
    }
  }

  function syncDarkModeToggle(theme) {
    const toggle = document.getElementById("darkModeToggle");
    if (!(toggle instanceof HTMLInputElement)) return;
    toggle.indeterminate = false;
    toggle.checked = theme === "cb-dark";
  }

  function syncThemeRadios(theme) {
    document.querySelectorAll('input[name="appearanceTheme"]').forEach((el) => {
      if (el instanceof HTMLInputElement) {
        el.checked = el.value === theme;
      }
    });
  }

  function applyTheme(theme, options) {
    const opts = options || {};
    const t = normalizeTheme(theme);

    document.documentElement.setAttribute("data-theme", t);

    const main = document.getElementById("appMain");
    if (main) {
      main.classList.add("layout-cb");
    }

    syncDarkModeToggle(t);
    syncThemeRadios(t);

    if (!opts.skipStorage) {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, t);
      } catch (_) {
        /* ignore */
      }
    }

    document.dispatchEvent(new CustomEvent("dualpeer-theme-change", { detail: { theme: t } }));
  }

  function getProfileName() {
    try {
      return (localStorage.getItem(PROFILE_NAME_KEY) || "Guest").trim() || "Guest";
    } catch (_) {
      return "Guest";
    }
  }

  function setProfileName(name) {
    const safe = String(name || "Guest").trim().slice(0, 32) || "Guest";
    try {
      localStorage.setItem(PROFILE_NAME_KEY, safe);
    } catch (_) {
      /* ignore */
    }
    refreshProfileLabels(safe);
  }

  function getAccountAvatarUrl() {
    const cached = global.DualPeerAuth?.getCachedProfile?.();
    if (cached?.avatarUrl) return cached.avatarUrl;
    const session = global.DualPeerAuth?.getSession?.();
    return session?.user?.avatarUrl || null;
  }

  function refreshProfileAvatars(avatarUrl) {
    const path = avatarUrl !== undefined ? avatarUrl : getAccountAvatarUrl();
    let src = "";
    if (path) {
      try {
        src = new URL(String(path), location.origin).href;
      } catch (_) {
        src = global.DualPeerAuth?.resolveAssetUrl ? global.DualPeerAuth.resolveAssetUrl(path) : String(path);
      }
    }
    document.querySelectorAll("[data-profile-avatar-photo]").forEach((img) => {
      if (!(img instanceof HTMLImageElement)) return;
      const wrap = img.closest("[data-account-avatar]");
      if (src) {
        img.src = src;
        img.hidden = false;
        img.alt = "";
        if (wrap) wrap.classList.add("has-photo");
      } else {
        img.hidden = true;
        img.removeAttribute("src");
        if (wrap) wrap.classList.remove("has-photo");
      }
    });
  }

  function refreshProfileLabels(name) {
    const label = name || getProfileName();
    const initial = label.charAt(0).toUpperCase() || "G";
    document.querySelectorAll("[data-profile-initial]").forEach((el) => {
      el.textContent = initial;
    });
    document.querySelectorAll("[data-profile-name]").forEach((el) => {
      el.textContent = label;
    });
    const input = document.getElementById("settingsDisplayName");
    if (input instanceof HTMLInputElement && document.activeElement !== input) {
      input.value = label === "Guest" ? "" : label;
    }
    refreshProfileAvatars();
  }

  const AUTH_MODAL_IDS = ["mailSettingsModal", "inviteModal", "premiumLoginModal", "adminUsersModal"];

  function setModalVisible(el, visible) {
    if (!el) return;
    el.hidden = !visible;
    if (visible) el.removeAttribute("aria-hidden");
    else el.setAttribute("aria-hidden", "true");
  }

  function getOpenAuthModal() {
    for (const id of AUTH_MODAL_IDS) {
      const el = document.getElementById(id);
      if (el && !el.hidden) return el;
    }
    return null;
  }

  function closeAuthModals() {
    AUTH_MODAL_IDS.forEach((id) => setModalVisible(document.getElementById(id), false));
    document.body.classList.remove("has-auth-modal-open");
  }

  function openAuthModal(id) {
    closeAuthModals();
    closeAccountMenu();
    const el = document.getElementById(id);
    setModalVisible(el, true);
    if (el) document.body.classList.add("has-auth-modal-open");
    return el;
  }

  function closeAccountMenu() {
    const menu = document.getElementById("accountMenu");
    const btn = document.getElementById("accountMenuBtn");
    const panel = document.getElementById("accountDropdown");
    if (menu) menu.classList.remove("is-open");
    if (btn) btn.setAttribute("aria-expanded", "false");
    if (panel) panel.hidden = true;
  }

  function openAccountMenu() {
    if (getOpenAuthModal()) closeAuthModals();
    const menu = document.getElementById("accountMenu");
    const btn = document.getElementById("accountMenuBtn");
    const panel = document.getElementById("accountDropdown");
    if (menu) menu.classList.add("is-open");
    if (btn) btn.setAttribute("aria-expanded", "true");
    if (panel) panel.hidden = false;
  }

  function initAccountMenu() {
    const btn = document.getElementById("accountMenuBtn");
    const panel = document.getElementById("accountDropdown");
    const logoutBtn = document.getElementById("accountLogoutBtn");
    const darkToggle = document.getElementById("darkModeToggle");

    refreshProfileLabels();
    global.addEventListener("dualpeer-profile-update", () => refreshProfileAvatars());
    global.addEventListener("dualpeer-auth-change", () => refreshProfileAvatars());

    if (btn && panel) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const menu = document.getElementById("accountMenu");
        if (menu && menu.classList.contains("is-open")) {
          closeAccountMenu();
        } else {
          openAccountMenu();
        }
      });
    }

    document.addEventListener("click", (e) => {
      const menu = document.getElementById("accountMenu");
      if (!menu || !menu.classList.contains("is-open")) return;
      if (e.target instanceof Node && menu.contains(e.target)) return;
      closeAccountMenu();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (getOpenAuthModal()) {
        closeAuthModals();
        e.preventDefault();
        return;
      }
      closeAccountMenu();
    });

    if (darkToggle instanceof HTMLInputElement) {
      darkToggle.addEventListener("change", () => {
        if (darkToggle.checked) {
          applyTheme("cb-dark");
        } else {
          applyTheme("cb-light");
        }
      });
    }

    if (logoutBtn) {
      logoutBtn.addEventListener("click", async () => {
        closeAccountMenu();
        if (typeof global.dualPeerPerformLogout === "function") {
          await global.dualPeerPerformLogout();
        } else {
          const legacy = document.getElementById("logoutBtn");
          if (legacy) legacy.click();
          else global.dispatchEvent(new CustomEvent("dualpeer-logout-request"));
        }
        location.reload();
      });
    }
  }

  function initSettingsPage() {
    const form = document.getElementById("settingsForm");
    const nameInput = document.getElementById("settingsDisplayName");

    applyTheme(getSavedTheme(), { skipStorage: true });
    initAccountMenu();

    document.querySelectorAll('input[name="appearanceTheme"]').forEach((el) => {
      if (!(el instanceof HTMLInputElement)) return;
      el.addEventListener("change", () => {
        if (el.checked) applyTheme(el.value);
      });
    });

    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (nameInput instanceof HTMLInputElement) {
          setProfileName(nameInput.value.trim() || "Guest");
        }
        const status = document.getElementById("settingsSavedMsg");
        if (status) {
          status.hidden = false;
          setTimeout(() => {
            status.hidden = true;
          }, 2500);
        }
      });
    }
  }

  function initShell() {
    applyTheme(getSavedTheme(), { skipStorage: true });
    initAccountMenu();
  }

  global.dualPeerUi = {
    applyTheme,
    getSavedTheme,
    initShell,
    initSettingsPage,
    setProfileName,
    getProfileName,
    closeAccountMenu,
    openAccountMenu,
    closeAuthModals,
    openAuthModal,
    getOpenAuthModal,
  };
})(window);
