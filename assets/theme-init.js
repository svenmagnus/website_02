/**
 * Apply saved theme before first paint and again on DOMContentLoaded.
 * Storage key: dualpeer-theme — values: cb-dark | cb-light | hippie
 *
 * Console: localStorage.setItem("dualpeer-theme", "hippie"); location.reload();
 */
(function (global) {
  var STORAGE_KEY = "dualpeer-theme";
  var ALLOWED = ["cb-dark", "cb-light", "hippie"];
  var DEFAULT_THEME = "cb-dark";

  function normalizeTheme(raw) {
    var t = String(raw == null ? "" : raw).trim().toLowerCase();
    if (t === "original") return DEFAULT_THEME;
    if (ALLOWED.indexOf(t) !== -1) return t;
    return DEFAULT_THEME;
  }

  function readThemeFromStorage() {
    try {
      return normalizeTheme(global.localStorage.getItem(STORAGE_KEY));
    } catch (_) {
      return DEFAULT_THEME;
    }
  }

  function applyThemeToDocument(theme) {
    var t = normalizeTheme(theme);
    var root = document.documentElement;
    if (!root) return t;
    root.setAttribute("data-theme", t);
    root.dataset.theme = t;
    return t;
  }

  function boot() {
    applyThemeToDocument(readThemeFromStorage());
  }

  boot();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  global.dualPeerTheme = {
    key: STORAGE_KEY,
    allowed: ALLOWED.slice(),
    read: readThemeFromStorage,
    apply: applyThemeToDocument,
    normalize: normalizeTheme,
  };
})();
