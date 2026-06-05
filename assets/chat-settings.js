/**
 * Live Chat appearance — compact inline layout + user settings (localStorage).
 * "You" colors are sent to the partner and used for your messages on their screen.
 */
(function (global) {
  const STORAGE_KEY = "dualpeer-chat-settings-v1";

  const THEME_DEFAULTS = {
    neon: {
      localName: "#22d3ee",
      localText: "#bae6fd",
      remoteName: "#fb923c",
      remoteText: "#fde68a",
      fontSize: 13,
    },
    "cb-dark": {
      localName: "#38bdf8",
      localText: "#e0f2fe",
      remoteName: "#f97316",
      remoteText: "#ffedd5",
      fontSize: 13,
    },
    "cb-light": {
      localName: "#0369a1",
      localText: "#0c4a6e",
      remoteName: "#c2410c",
      remoteText: "#431407",
      fontSize: 13,
    },
    hippie: {
      localName: "#c084fc",
      localText: "#f3e8ff",
      remoteName: "#facc15",
      remoteText: "#fef9c3",
      fontSize: 13,
    },
  };

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") || "neon";
  }

  function defaultSettings() {
    return { ...(THEME_DEFAULTS[currentTheme()] || THEME_DEFAULTS.neon), partnerSharedColors: null };
  }

  function normalizeSharedColors(raw) {
    if (!raw || typeof raw !== "object") return null;
    const name = String(raw.name || "").trim();
    const text = String(raw.text || "").trim();
    if (!name && !text) return null;
    const base = defaultSettings();
    return { name: name || base.remoteName, text: text || base.remoteText };
  }

  function loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!raw || typeof raw !== "object") return defaultSettings();
      const base = defaultSettings();
      return {
        localName: raw.localName || base.localName,
        localText: raw.localText || base.localText,
        fontSize: Number(raw.fontSize) || base.fontSize,
        partnerSharedColors: normalizeSharedColors(raw.partnerSharedColors),
      };
    } catch (_) {
      return defaultSettings();
    }
  }

  function saveSettings(next) {
    const merged = { ...loadSettings(), ...next };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    } catch (_) {
      /* ignore */
    }
    applySettings(merged);
    return merged;
  }

  function applySettings(settings) {
    const s = settings || loadSettings();
    const root = document.documentElement;
    root.style.setProperty("--chat-local-name-color", s.localName);
    root.style.setProperty("--chat-local-text-color", s.localText);
    root.style.setProperty("--chat-font-size", `${s.fontSize}px`);
  }

  function getMyDisplayColors() {
    const s = loadSettings();
    return { name: s.localName, text: s.localText };
  }

  function resolveRemoteColors() {
    const shared = loadSettings().partnerSharedColors;
    if (shared) return shared;
    const defs = defaultSettings();
    return { name: defs.remoteName, text: defs.remoteText };
  }

  function shareMyDisplayColors() {
    global.dispatchEvent(new CustomEvent("dualpeer-chat-display-colors-share"));
    global.dispatchEvent(new CustomEvent("dualpeer-profile-share-request"));
  }

  function setPartnerSharedColors(colors) {
    const normalized = normalizeSharedColors(colors);
    if (!normalized) return;
    saveSettings({ partnerSharedColors: normalized });
    updatePartnerPreview(loadSettings());
    global.dispatchEvent(new CustomEvent("dualpeer-chat-colors-updated"));
  }

  function formatTechniqueBody(body, isLocal, senderName) {
    const action = String(body || "").trim();
    if (/requests:/i.test(action) || action.startsWith("You request:")) return action;
    return isLocal
      ? `You request: ${action}`
      : `${String(senderName || "Partner").trim()} requests: ${action}`;
  }

  function applyRemoteColorsToLine(senderEl, textEl) {
    const colors = resolveRemoteColors();
    if (senderEl) senderEl.style.color = colors.name;
    if (textEl) textEl.style.color = colors.text;
  }

  function buildMessageElement({ isLocal, senderName, body, kind, createdAt, uid, message }) {
    const m = message || {};
    const msgKind = kind || m.kind || "text";
    const isSelf = isLocal != null ? isLocal : m.senderUserId === uid;
    const role =
      msgKind === "system" ? "system" : msgKind === "technique" ? (isSelf ? "local" : "remote") : isSelf ? "local" : "remote";
    const name = isSelf ? "You" : m.senderName || senderName || "Partner";
    let text = body != null ? body : m.body;
    if (msgKind === "technique") {
      text = formatTechniqueBody(text, isSelf, name);
    }

    const msg = document.createElement("div");
    msg.className = `chat-message chat-message--${role} chat-message--compact`;
    msg.classList.add(isSelf ? "local" : "remote");
    if (msgKind === "system") msg.classList.add("chat-message--system");
    if (msgKind === "technique") msg.classList.add("chat-message--technique");

    const at = createdAt || m.createdAt;
    if (at) {
      const d = new Date(at);
      msg.title = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    const line = document.createElement("div");
    line.className = "chat-line";

    let sender = null;
    if (msgKind !== "system") {
      sender = document.createElement("span");
      sender.className = "chat-sender";
      sender.textContent = name;
      line.appendChild(sender);
    }

    const textNode = document.createElement("span");
    textNode.className = "chat-text";
    textNode.textContent = String(text || "");
    line.appendChild(textNode);

    if (!isSelf && msgKind !== "system") {
      applyRemoteColorsToLine(sender, textNode);
    }

    msg.appendChild(line);
    return msg;
  }

  function updatePartnerPreview(settings) {
    const s = settings || loadSettings();
    const hint = document.getElementById("chatPartnerColorsHint");
    const nameSwatch = document.getElementById("chatPartnerSharedNameSwatch");
    const textSwatch = document.getElementById("chatPartnerSharedTextSwatch");
    const colors = s.partnerSharedColors || resolveRemoteColors();

    if (hint) {
      hint.textContent = s.partnerSharedColors
        ? "Your partner chose these colors under You — used for their messages here."
        : "Waiting for partner colors (they set these under You on their screen).";
    }
    if (nameSwatch instanceof HTMLElement) {
      nameSwatch.style.background = colors.name;
      nameSwatch.title = colors.name;
    }
    if (textSwatch instanceof HTMLElement) {
      textSwatch.style.background = colors.text;
      textSwatch.title = colors.text;
    }
  }

  function fillSettingsForm(settings) {
    const map = {
      chatLocalNameColor: settings.localName,
      chatLocalTextColor: settings.localText,
      chatFontSize: settings.fontSize,
    };
    Object.entries(map).forEach(([id, value]) => {
      const el = document.getElementById(id);
      if (!(el instanceof HTMLInputElement)) return;
      el.value = String(value);
    });
    const label = document.getElementById("chatFontSizeVal");
    if (label) label.textContent = `${settings.fontSize}px`;
    updatePartnerPreview(settings);
  }

  function readSettingsForm() {
    const pick = (id) => {
      const el = document.getElementById(id);
      return el instanceof HTMLInputElement ? el.value : "";
    };
    const saved = saveSettings({
      fontSize: Number(pick("chatFontSize")) || defaultSettings().fontSize,
      localName: pick("chatLocalNameColor"),
      localText: pick("chatLocalTextColor"),
    });
    shareMyDisplayColors();
    return saved;
  }

  function initChatSettingsUI() {
    applySettings(loadSettings());
    fillSettingsForm(loadSettings());

    const panel = document.getElementById("chatSettings");
    if (!panel) return;

    panel.querySelectorAll("#chatLocalNameColor, #chatLocalTextColor").forEach((input) => {
      input.addEventListener("input", () => readSettingsForm());
      input.addEventListener("change", () => readSettingsForm());
    });

    const fontInput = document.getElementById("chatFontSize");
    if (fontInput instanceof HTMLInputElement) {
      fontInput.addEventListener("input", () => {
        const label = document.getElementById("chatFontSizeVal");
        if (label) label.textContent = `${fontInput.value}px`;
        saveSettings({ fontSize: Number(fontInput.value) || defaultSettings().fontSize });
      });
      fontInput.addEventListener("change", () => readSettingsForm());
    }

    document.getElementById("btnChatSettingsReset")?.addEventListener("click", () => {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (_) {
        /* ignore */
      }
      const defaults = defaultSettings();
      applySettings(defaults);
      fillSettingsForm(defaults);
      shareMyDisplayColors();
    });

    global.addEventListener("dualpeer-partner-profile", (e) => {
      const colors = e.detail?.profile?.chatColors;
      if (colors) setPartnerSharedColors(colors);
    });
  }

  global.DualPeerChatUi = {
    loadSettings,
    saveSettings,
    applySettings,
    defaultSettings,
    getMyDisplayColors,
    setPartnerSharedColors,
    buildMessageElement,
    initChatSettingsUI,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initChatSettingsUI);
  } else {
    initChatSettingsUI();
  }
})(window);
