/**
 * Load Lovense LAN SDK (lan.js) on demand — avoids localhost port spam on login/profile.
 */
(function (global) {
  const LAN_SRC = "https://api.lovense.com/api/lan/v2/lan.js";
  let loadPromise = null;

  function isLanReady() {
    return typeof global.lovense !== "undefined" && typeof global.lovense.sendCommand === "function";
  }

  function loadLovenseLanScript() {
    if (isLanReady()) return Promise.resolve(true);
    if (loadPromise) return loadPromise;
    loadPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-lovense-lan="1"]');
      if (existing) {
        existing.addEventListener("load", () => resolve(isLanReady()), { once: true });
        existing.addEventListener("error", () => reject(new Error("Lovense LAN SDK failed")), {
          once: true,
        });
        return;
      }
      const script = document.createElement("script");
      script.src = LAN_SRC;
      script.async = true;
      script.dataset.lovenseLan = "1";
      script.onload = () => resolve(isLanReady());
      script.onerror = () => reject(new Error("Lovense LAN SDK failed to load"));
      document.head.appendChild(script);
    });
    return loadPromise;
  }

  global.loadLovenseLanScript = loadLovenseLanScript;
})(window);
