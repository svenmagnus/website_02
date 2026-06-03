/**
 * Floating Messages panel — drag and resize.
 */
(function (global) {
  const STORAGE_KEY = "dualpeer-messages-panel-geom";
  const DEFAULTS = { left: 80, top: 72, width: 380, height: 480 };

  function loadGeom() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (raw && typeof raw === "object") return { ...DEFAULTS, ...raw };
    } catch (_) {
      /* ignore */
    }
    return { ...DEFAULTS };
  }

  function saveGeom(panel) {
    const rect = panel.getBoundingClientRect();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      })
    );
  }

  function applyGeom(panel, geom) {
    panel.style.left = `${Math.max(0, geom.left)}px`;
    panel.style.top = `${Math.max(0, geom.top)}px`;
    panel.style.width = `${Math.max(280, geom.width)}px`;
    panel.style.height = `${Math.max(320, geom.height)}px`;
  }

  function initMessagesPanel() {
    const btn = document.getElementById("btnHeaderChat");
    const panel = document.getElementById("floatingMessagesPanel");
    const closeBtn = document.getElementById("headerChatClose");
    const dragHandle = panel?.querySelector("[data-messages-drag]");
    const resizeHandle = panel?.querySelector("[data-messages-resize]");

    if (!btn || !panel) return;

    document.body.appendChild(panel);
    const geom = loadGeom();
    applyGeom(panel, geom);

    const setOpen = (open) => {
      panel.hidden = !open;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        panel.style.zIndex = String(10000 + Math.floor(Date.now() % 1000));
        document.getElementById("headerChatInput")?.focus();
      }
    };

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!global.DualPeerAuth?.isLoggedIn?.()) {
        global.DualPeerAuth?.openPremiumLoginModal?.();
        return;
      }
      setOpen(panel.hidden);
    });

    closeBtn?.addEventListener("click", () => setOpen(false));

    let drag = null;
    dragHandle?.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      e.preventDefault();
      const rect = panel.getBoundingClientRect();
      drag = { startX: e.clientX, startY: e.clientY, left: rect.left, top: rect.top };
      dragHandle.setPointerCapture(e.pointerId);
    });
    dragHandle?.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const left = drag.left + (e.clientX - drag.startX);
      const top = drag.top + (e.clientY - drag.startY);
      panel.style.left = `${Math.max(0, left)}px`;
      panel.style.top = `${Math.max(0, top)}px`;
    });
    dragHandle?.addEventListener("pointerup", (e) => {
      if (!drag) return;
      drag = null;
      dragHandle.releasePointerCapture(e.pointerId);
      saveGeom(panel);
    });

    let resize = null;
    resizeHandle?.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const rect = panel.getBoundingClientRect();
      resize = {
        startX: e.clientX,
        startY: e.clientY,
        width: rect.width,
        height: rect.height,
      };
      resizeHandle.setPointerCapture(e.pointerId);
    });
    resizeHandle?.addEventListener("pointermove", (e) => {
      if (!resize) return;
      const w = Math.max(280, resize.width + (e.clientX - resize.startX));
      const h = Math.max(320, resize.height + (e.clientY - resize.startY));
      panel.style.width = `${w}px`;
      panel.style.height = `${h}px`;
    });
    resizeHandle?.addEventListener("pointerup", (e) => {
      if (!resize) return;
      resize = null;
      resizeHandle.releasePointerCapture(e.pointerId);
      saveGeom(panel);
    });

    global.DualPeerMessagesPanel = { open: () => setOpen(true), close: () => setOpen(false) };
    global.DualPeerChat?.ensureEmojiBars?.();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initMessagesPanel);
  } else {
    initMessagesPanel();
  }
})(window);
