/**
 * Apply saved theme before first paint (cb-dark | cb-light | hippie).
 */
(function () {
  var ALLOWED = ["cb-dark", "cb-light", "hippie"];
  try {
    var t = localStorage.getItem("dualpeer-theme") || "cb-dark";
    if (t === "original") t = "cb-dark";
    if (ALLOWED.indexOf(t) === -1) t = "cb-dark";
    document.documentElement.setAttribute("data-theme", t);
  } catch (_) {
    document.documentElement.setAttribute("data-theme", "cb-dark");
  }
})();
