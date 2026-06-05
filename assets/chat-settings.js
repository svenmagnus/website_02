/**
 * Live Chat appearance — compact inline layout + user settings (localStorage).
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
    return { ...(THEME_DEFAULTS[currentTheme()] || THEME_DEFAULTS.neon) };
  }

  function loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!raw || typeof raw !== "object") return defaultSettings();
      const base = defaultSettings();
      return {
        localName: raw.localName || base.localName,
        localText: raw.localText || base.localText,
        remoteName: raw.remoteName || base.remoteName,
        remoteText: raw.remoteText || base.remoteText,
        fontSize: Number(raw.fontSize) || base.fontSize,
        partnerColorsUnlocked: Boolean(raw.partnerColorsUnlocked),
        partnerColorsPending: Boolean(raw.partnerColorsPending),
        partnerColorsApprovalPending: Boolean(raw.partnerColorsApprovalPending),
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
    root.style.setProperty("--chat-remote-name-color", s.remoteName);
    root.style.setProperty("--chat-remote-text-color", s.remoteText);
    root.style.setProperty("--chat-font-size", `${s.fontSize}px`);
  }

  function formatTechniqueBody(body, isLocal, senderName) {
    const action = String(body || "").trim();
    if (/requests:/i.test(action) || action.startsWith("You request:")) return action;
    return isLocal
      ? `You request: ${action}`
      : `${String(senderName || "Partner").trim()} requests: ${action}`;
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

    if (msgKind !== "system") {
      const sender = document.createElement("span");
      sender.className = "chat-sender";
      sender.textContent = name;
      line.appendChild(sender);
    }

    const textNode = document.createElement("span");
    textNode.className = "chat-text";
    textNode.textContent = String(text || "");
    line.appendChild(textNode);
    msg.appendChild(line);
    return msg;
  }

  function updatePartnerColorsUi(settings) {
    const s = settings || loadSettings();
    const group = document.getElementById("chatPartnerColorsGroup");
    const hint = document.getElementById("chatPartnerColorsHint");
    const requestBtn = document.getElementById("btnChatPartnerColorsRequest");
    const approveBtn = document.getElementById("btnChatPartnerColorsApprove");
    const nameInput = document.getElementById("chatRemoteNameColor");
    const textInput = document.getElementById("chatRemoteTextColor");
    const unlocked = s.partnerColorsUnlocked;

    if (nameInput instanceof HTMLInputElement) nameInput.disabled = !unlocked;
    if (textInput instanceof HTMLInputElement) textInput.disabled = !unlocked;
    group?.classList.toggle("is-locked", !unlocked);

    if (hint) {
      hint.className = "chat-settings-partner-hint";
      if (s.partnerColorsApprovalPending) {
        hint.textContent = "Your partner wants to customize how they see your messages. Approve?";
        hint.classList.add("pending");
      } else if (s.partnerColorsPending) {
        hint.textContent = "Waiting for partner approval…";
        hint.classList.add("pending");
      } else if (unlocked) {
        hint.textContent = "Approved — these colors apply to your partner on your screen only.";
        hint.classList.add("ok");
      } else {
        hint.textContent = "Customize how you see your partner. Requires their approval first.";
      }
    }

    if (requestBtn instanceof HTMLButtonElement) {
      requestBtn.hidden = unlocked || s.partnerColorsPending;
      requestBtn.disabled = Boolean(s.partnerColorsPending);
    }
    if (approveBtn instanceof HTMLButtonElement) {
      approveBtn.hidden = !s.partnerColorsApprovalPending;
    }
  }

  function requestPartnerColorsApproval() {
    const s = loadSettings();
    if (s.partnerColorsUnlocked) return;
    saveSettings({ ...s, partnerColorsPending: true });
    updatePartnerColorsUi(loadSettings());
    global.dispatchEvent(new CustomEvent("dualpeer-chat-partner-colors-request"));
  }

  function grantPartnerColorsApproval() {
    saveSettings({
      ...loadSettings(),
      partnerColorsApprovalPending: false,
    });
    updatePartnerColorsUi(loadSettings());
    global.dispatchEvent(new CustomEvent("dualpeer-chat-partner-colors-grant"));
  }

  function onPartnerColorsRequest(fromName) {
    saveSettings({
      ...loadSettings(),
      partnerColorsApprovalPending: true,
    });
    updatePartnerColorsUi(loadSettings());
    const panel = document.getElementById("chatSettings");
    if (panel instanceof HTMLDetailsElement) panel.open = true;
    if (global.playTechniqueBell) global.playTechniqueBell();
    void fromName;
  }

  function onPartnerColorsGrant() {
    saveSettings({
      ...loadSettings(),
      partnerColorsUnlocked: true,
      partnerColorsPending: false,
    });
    updatePartnerColorsUi(loadSettings());
  }

  function onPartnerColorsDenied() {
    saveSettings({
      ...loadSettings(),
      partnerColorsPending: false,
    });
    updatePartnerColorsUi(loadSettings());
  }

  function fillSettingsForm(settings) {
    const map = {
      chatLocalNameColor: settings.localName,
      chatLocalTextColor: settings.localText,
      chatRemoteNameColor: settings.remoteName,
      chatRemoteTextColor: settings.remoteText,
      chatFontSize: settings.fontSize,
    };
    Object.entries(map).forEach(([id, value]) => {
      const el = document.getElementById(id);
      if (!(el instanceof HTMLInputElement)) return;
      el.value = String(value);
    });
    const label = document.getElementById("chatFontSizeVal");
    if (label) label.textContent = `${settings.fontSize}px`;
    updatePartnerColorsUi(settings);
  }

  function readSettingsForm() {
    const s = loadSettings();
    const pick = (id) => {
      const el = document.getElementById(id);
      return el instanceof HTMLInputElement ? el.value : "";
    };
    const next = {
      fontSize: Number(pick("chatFontSize")) || defaultSettings().fontSize,
      localName: pick("chatLocalNameColor"),
      localText: pick("chatLocalTextColor"),
    };
    if (s.partnerColorsUnlocked) {
      next.remoteName = pick("chatRemoteNameColor");
      next.remoteText = pick("chatRemoteTextColor");
    }
    return saveSettings(next);
  }

  function initChatSettingsUI() {
    applySettings(loadSettings());
    fillSettingsForm(loadSettings());

    const panel = document.getElementById("chatSettings");
    if (!panel) return;

    panel.querySelectorAll("input[type='color']").forEach((input) => {
      input.addEventListener("input", () => readSettingsForm());
      input.addEventListener("change", () => readSettingsForm());
    });

    const fontInput = document.getElementById("chatFontSize");
    if (fontInput instanceof HTMLInputElement) {
      fontInput.addEventListener("input", () => {
        const label = document.getElementById("chatFontSizeVal");
        if (label) label.textContent = `${fontInput.value}px`;
        readSettingsForm();
      });
      fontInput.addEventListener("change", () => readSettingsForm());
    }

    document.getElementById("btnChatSettingsReset")?.addEventListener("click", () => {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (_) {
        /* ignore */
      }
      const defaults = { ...defaultSettings(), partnerColorsUnlocked: false };
      applySettings(defaults);
      fillSettingsForm(defaults);
    });

    document.getElementById("btnChatPartnerColorsRequest")?.addEventListener("click", () => {
      requestPartnerColorsApproval();
    });
    document.getElementById("btnChatPartnerColorsApprove")?.addEventListener("click", () => {
      grantPartnerColorsApproval();
    });

    global.addEventListener("dualpeer-chat-partner-colors-denied", () => {
      onPartnerColorsDenied();
    });
  }

  global.DualPeerChatUi = {
    loadSettings,
    saveSettings,
    applySettings,
    defaultSettings,
    buildMessageElement,
    initChatSettingsUI,
    onPartnerColorsRequest,
    onPartnerColorsGrant,
    onPartnerColorsDenied,
    updatePartnerColorsUi,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initChatSettingsUI);
  } else {
    initChatSettingsUI();
  }
})(window);
