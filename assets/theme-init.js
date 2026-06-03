/**
 * Theme bootstrap — runs before paint and on DOMContentLoaded.
 * Storage key: theme (values: cb-dark | cb-light | hippie).
 * Migrates legacy dualpeer-theme on first read.
 */
(function (global) {
  var STORAGE_KEY = "theme";
  var LEGACY_KEY = "dualpeer-theme";
  var ALLOWED = ["cb-dark", "cb-light", "hippie"];
  var DEFAULT_THEME = "cb-dark";

  var ALIASES = {
    original: "cb-dark",
    dark: "cb-dark",
    light: "cb-light",
    hippie: "hippie",
    "cb-dark": "cb-dark",
    "cb-light": "cb-light",
  };

  function normalizeTheme(raw) {
    var t = String(raw == null ? "" : raw).trim().toLowerCase();
    if (ALIASES[t]) return ALIASES[t];
    if (ALLOWED.indexOf(t) !== -1) return t;
    return DEFAULT_THEME;
  }

  function readRawFromStorage() {
    try {
      var current = global.localStorage.getItem(STORAGE_KEY);
      if (current != null && String(current).trim() !== "") {
        return current;
      }
      var legacy = global.localStorage.getItem(LEGACY_KEY);
      if (legacy != null && String(legacy).trim() !== "") {
        var migrated = normalizeTheme(legacy);
        global.localStorage.setItem(STORAGE_KEY, migrated);
        global.localStorage.removeItem(LEGACY_KEY);
        return migrated;
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  function readThemeFromStorage() {
    return normalizeTheme(readRawFromStorage());
  }

  function persistTheme(theme) {
    var t = normalizeTheme(theme);
    try {
      global.localStorage.setItem(STORAGE_KEY, t);
      global.localStorage.removeItem(LEGACY_KEY);
    } catch (_) {
      /* ignore */
    }
    return t;
  }

  function applyThemeToDocument(theme, options) {
    var opts = options || {};
    var t = opts.persist === false ? normalizeTheme(theme) : persistTheme(theme);
    var root = document.documentElement;
    if (!root) return t;
    root.setAttribute("data-theme", t);
    root.dataset.theme = t;
    return t;
  }

  function boot() {
    applyThemeToDocument(readThemeFromStorage(), { persist: false });
  }

  boot();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  global.dualPeerTheme = {
    key: STORAGE_KEY,
    legacyKey: LEGACY_KEY,
    allowed: ALLOWED.slice(),
    read: readThemeFromStorage,
    persist: persistTheme,
    apply: applyThemeToDocument,
    normalize: normalizeTheme,
  };
})();
