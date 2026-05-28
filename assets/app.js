/**
 * Dual-Peer-Demo: Video + DataChannel für Fern-Befehle.
 * Lovense: If broadcast.js and direct toy API are available,
 * vibration commands are sent directly to the hardware.
 */

/** Zugang zur App (Video + Kamera-Buttons) — nur Demo, nicht als alleinige Absicherung nutzen. */
const VIDEO_ACCESS_PASSWORD = "Velvet_Touch";
const SESSION_VIDEO_UNLOCK_KEY = "dualpeer-app-session-v2";

// Echte TURN-Konfiguration (Beispiel OpenRelay)
const TURN_SERVER_HOST = "openrelay.metered.ca";
const TURN_USERNAME_PLACEHOLDER = "openrelayproject";
const TURN_CREDENTIAL_PLACEHOLDER = "openrelayproject";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: [
      `turn:${TURN_SERVER_HOST}:3478?transport=udp`,
      `turn:${TURN_SERVER_HOST}:3478?transport=tcp`,
    ],
    username: TURN_USERNAME_PLACEHOLDER,
    credential: TURN_CREDENTIAL_PLACEHOLDER,
  },
  {
    urls: [`turns:${TURN_SERVER_HOST}:5349?transport=tcp`],
    username: TURN_USERNAME_PLACEHOLDER,
    credential: TURN_CREDENTIAL_PLACEHOLDER,
  },
];

const PEER_CONNECTION_CONFIG = {
  iceServers: ICE_SERVERS,
};

const PEER_OPTIONS = {
  debug: 0,
  config: PEER_CONNECTION_CONFIG,
};

const $ = (sel) => document.querySelector(sel);

let videoAccessUnlocked = false;

const els = {
  stage: $("#stage"),
  localVideo: $("#localVideo"),
  remoteVideo: $("#remoteVideo"),
  localPlaceholder: $("#localPlaceholder"),
  remotePlaceholder: $("#remotePlaceholder"),
  localPulse: $("#localPulse"),
  remotePulse: $("#remotePulse"),
  btnStartHost: $("#btnStartHost"),
  btnConnect: $("#btnConnect"),
  btnHangup: $("#btnHangup"),
  peerIdOut: $("#peerIdOut"),
  peerIdIn: $("#peerIdIn"),
  statusHost: $("#statusHost"),
  statusGuest: $("#statusGuest"),
  statusData: $("#statusData"),
  toyControlList: $("#toyControlList"),
  chatMessages: $("#chat-messages"),
  chatInput: $("#chat-input"),
  chatSend: $("#chat-send"),
  lovenseStatus: $("#lovenseStatus"),
  lovenseToyStatus: $("#lovenseToyStatus"),
  lovenseUrlHint: $("#lovenseUrlHint"),
  lovenseModelName: $("#lovenseModelName"),
  btnLovenseTestTip: $("#btnLovenseTestTip"),
  pipCorner: $("#pipCorner"),
  pipNativeMsg: $("#pipNativeMsg"),
  btnPipNativeRemote: $("#btnPipNativeRemote"),
  btnPipNativeLocal: $("#btnPipNativeLocal"),
  loginOverlay: $("#loginOverlay"),
  accessPassword: $("#accessPassword"),
  accessUnlock: $("#accessUnlock"),
  accessError: $("#accessError"),
  logoutBtn: $("#logoutBtn"),
};

let peer = null;
let localStream = null;
let mediaConn = null;
let dataConn = null;
let camExtensionInstance = null;
let lovenseReady = false;
/** @type {"host"|"guest"|null} */
let sessionRole = null;

const LAYOUT_STORAGE_KEY = "dualpeer-layout";

function setPipNativeMessage(text) {
  if (els.pipNativeMsg) els.pipNativeMsg.textContent = text || "";
}

function applyLayout(mode) {
  const allowed = ["split", "pip-remote", "pip-local"];
  const m = allowed.includes(mode) ? mode : "split";
  if (els.stage) els.stage.dataset.layout = m;
  document.querySelectorAll(".layout-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-layout") === m);
  });
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, m);
  } catch (_) {
    /* ignore */
  }
}

function applyPipCorner(corner) {
  const c = ["br", "bl", "tr", "tl"].includes(corner) ? corner : "br";
  if (els.stage) els.stage.dataset.pipCorner = c;
  if (els.pipCorner) els.pipCorner.value = c;
  try {
    localStorage.setItem("dualpeer-pip-corner", c);
  } catch (_) {
    /* ignore */
  }
}

function initLayoutControls() {
  let saved = "split";
  let corner = "br";
  try {
    saved = localStorage.getItem(LAYOUT_STORAGE_KEY) || "split";
    corner = localStorage.getItem("dualpeer-pip-corner") || "br";
  } catch (_) {
    /* ignore */
  }
  applyLayout(saved);
  applyPipCorner(corner);

  document.querySelectorAll(".layout-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyLayout(btn.getAttribute("data-layout") || "split");
    });
  });

  if (els.pipCorner) {
    els.pipCorner.addEventListener("change", () => {
      applyPipCorner(els.pipCorner.value);
    });
  }

  const pipOk = document.pictureInPictureEnabled;
  if (els.btnPipNativeRemote) els.btnPipNativeRemote.disabled = !pipOk;
  if (els.btnPipNativeLocal) els.btnPipNativeLocal.disabled = !pipOk;
  if (!pipOk) {
    setPipNativeMessage("Browser PiP is not supported here.");
  }

  async function toggleDocumentPip(video) {
    if (!document.pictureInPictureEnabled || !video) return;
    try {
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture();
        setPipNativeMessage("PiP window closed.");
      } else {
        await video.requestPictureInPicture();
        setPipNativeMessage("PiP window active (tab can stay in background).");
      }
    } catch (e) {
      setPipNativeMessage("PiP: " + (e && e.message ? e.message : String(e)));
    }
  }

  if (els.btnPipNativeRemote) {
    els.btnPipNativeRemote.addEventListener("click", () => toggleDocumentPip(els.remoteVideo));
  }
  if (els.btnPipNativeLocal) {
    els.btnPipNativeLocal.addEventListener("click", () => toggleDocumentPip(els.localVideo));
  }

  document.addEventListener("leavepictureinpicture", () => {
    setPipNativeMessage("");
  });
}

function setStatus(el, text, cls) {
  if (!el) return;
  el.textContent = text;
  el.className = "status-line" + (cls ? " " + cls : "");
}

function showPlaceholder(local, show) {
  const ph = local ? els.localPlaceholder : els.remotePlaceholder;
  if (ph) ph.hidden = !show;
}

function pulseFor(side, ms = 800) {
  const pulse = side === "local" ? els.localPulse : els.remotePulse;
  if (!pulse) return;
  pulse.classList.add("active");
  clearTimeout(pulse._t);
  pulse._t = setTimeout(() => pulse.classList.remove("active"), ms);
}

async function getMedia() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 1280 } },
    audio: true,
  });
  els.localVideo.srcObject = localStream;
  showPlaceholder(true, false);
  return localStream;
}

function stopMedia() {
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  els.localVideo.srcObject = null;
  els.remoteVideo.srcObject = null;
  showPlaceholder(true, true);
  showPlaceholder(false, true);
}

function hangup() {
  if (mediaConn) {
    mediaConn.close();
    mediaConn = null;
  }
  if (dataConn) {
    dataConn.close();
    dataConn = null;
  }
  if (peer) {
    peer.destroy();
    peer = null;
  }
  sessionRole = null;
  stopMedia();
  els.peerIdOut.textContent = "—";
  resetConnectionLabels();
  els.btnStartHost.disabled = !videoAccessUnlocked;
  els.btnConnect.disabled = !videoAccessUnlocked;
}

function resetConnectionLabels() {
  setStatus(els.statusHost, "Host: not started yet.");
  setStatus(els.statusGuest, "Guest: not connected yet.");
  updateConnectionUi();
}

function hasRemoteVideo() {
  return !!(els.remoteVideo && els.remoteVideo.srcObject);
}

function updatePeerConnectionStatus() {
  const videoOk = hasRemoteVideo();
  const dataOk = !!(dataConn && dataConn.open);

  if (sessionRole === "host") {
    if (!videoOk && !dataOk) return;
    if (videoOk && dataOk) {
      setStatus(els.statusHost, "Partner connected (video + control).", "ok");
    } else if (videoOk) {
      setStatus(els.statusHost, "Partner connected (video).", "ok");
    } else if (dataOk) {
      setStatus(els.statusHost, "Partner connected (control).", "ok");
    }
    setStatus(els.statusGuest, "Partner connected.", "ok");
  } else if (sessionRole === "guest") {
    if (videoOk && dataOk) {
      setStatus(els.statusGuest, "Connected (video + control).", "ok");
    } else if (videoOk) {
      setStatus(els.statusGuest, "Video connected — control: establishing …", "ok");
    } else if (peer) {
      setStatus(els.statusGuest, "Establishing connection …", "ok");
    }
  }
}

function updateDataConnStatus() {
  if (!els.statusData) return;
  if (dataConn && dataConn.open) {
    setStatus(
      els.statusData,
      "Data channel: connected — remote control active (also in background tab).",
      "ok"
    );
  } else if (dataConn) {
    setStatus(els.statusData, "Data channel: establishing …");
  } else {
    setStatus(els.statusData, "Data channel: disconnected.");
  }
}

function updateConnectionUi() {
  updatePeerConnectionStatus();
  updateDataConnStatus();
}

function setPeerStatus(msg, cls) {
  if (sessionRole === "host") {
    setStatus(els.statusHost, msg, cls);
  } else if (sessionRole === "guest") {
    setStatus(els.statusGuest, msg, cls);
  } else {
    setStatus(els.statusHost, msg, cls);
    setStatus(els.statusGuest, msg, cls);
  }
}

function setDataActivityStatus(msg, cls) {
  if (els.statusData) setStatus(els.statusData, msg, cls);
}

const TOY_PRESET_LEVELS = [
  { label: "Low", value: 20 },
  { label: "Medium", value: 45 },
  { label: "High", value: 70 },
  { label: "Max", value: 100 },
  { label: "Ultra", value: 100 },
];

const TOY_VIBRATE_MAX_STRENGTH = 20;

const TOY_SPECIAL_COMMANDS = [
  { id: "earthquake", label: "Earthquake" },
  { id: "pulse", label: "Pulse" },
  { id: "wave", label: "Wave" },
  { id: "fireworks", label: "Fireworks" },
];

let toyControlState = {};
const TOY_SLIDER_THROTTLE_MS = 150;
let toyThrottleState = {};

function getConnectedToys() {
  const toys = window.dualPeerLovense?.toys;
  if (Array.isArray(toys) && toys.length) return toys;
  return [{ id: "default-toy", type: "Toy", status: "on" }];
}

function percentToVibrateStrength(levelPercent) {
  const level = Math.max(0, Math.min(100, Number(levelPercent) || 0));
  return Math.max(0, Math.min(TOY_VIBRATE_MAX_STRENGTH, Math.round((level / 100) * TOY_VIBRATE_MAX_STRENGTH)));
}

/**
 * Direct hardware vibration — no virtual tips/tokens.
 * Payload shape: { type: "toy", action: "Vibrate", strength: 0..20 }
 */
function sendDirectVibration(levelPercent, toyId) {
  const strength = percentToVibrateStrength(levelPercent);
  const modelName = (window.__LOVENSE_MODEL_NAME__ || "model1").trim() || "model1";
  const safeToyId = toyId || "default-toy";

  const payload = {
    type: "toy",
    action: "Vibrate",
    strength,
    model: modelName,
  };
  if (safeToyId && safeToyId !== "default-toy") payload.toyId = safeToyId;

  try {
    if (typeof window.lovense !== "undefined" && typeof window.lovense.sendAction === "function") {
      window.lovense.sendAction(payload);
      return true;
    }

    const bridge = window.dualPeerLovense;
    if (bridge && typeof bridge.sendVibrate === "function") {
      return bridge.sendVibrate(strength, safeToyId !== "default-toy" ? safeToyId : undefined);
    }
    if (bridge && bridge.instance && typeof bridge.instance.sendAction === "function") {
      bridge.instance.sendAction(payload);
      return true;
    }

    return false;
  } catch (error) {
    console.error("Direct vibrate command failed:", error);
    return false;
  }
}

function sendRemoteIntensity(levelPercent, toyId) {
  if (!dataConn || !dataConn.open) {
    setDataActivityStatus("No data channel — connect first.", "err");
    return false;
  }
  const level = Math.max(0, Math.min(100, Math.round(Number(levelPercent) || 0)));
  try {
    dataConn.send({
      type: "toy",
      toyId: toyId || "default-toy",
      level,
      ts: Date.now(),
    });
    setDataActivityStatus(level <= 0 ? `Stop sent to partner (${toyId}).` : `Intensity ${level}% sent to partner.`, "ok");
  } catch (e) {
    setDataActivityStatus("Send failed: " + (e && e.message ? e.message : String(e)), "err");
  }
}

function getToyThrottleState(toyId) {
  const id = toyId || "default-toy";
  if (!toyThrottleState[id]) {
    toyThrottleState[id] = { lastSentAt: 0, trailingTimer: null, pending: null };
  }
  return toyThrottleState[id];
}

function clearToyThrottleState(toyId) {
  const state = toyThrottleState[toyId];
  if (!state) return;
  if (state.trailingTimer) {
    clearTimeout(state.trailingTimer);
    state.trailingTimer = null;
  }
  state.pending = null;
}

function clearAllToyPendingSends() {
  Object.keys(toyThrottleState).forEach((toyId) => clearToyThrottleState(toyId));
}

function flushToyIntensity(levelPercent, toyId, remote) {
  sendDirectVibration(levelPercent, toyId);
  if (remote) sendRemoteIntensity(levelPercent, toyId);
}

function applyToyIntensity(toyId, levelPercent, options) {
  const opts = options || {};
  const remote = opts.remote !== false;
  const throttle = !!opts.throttle;
  const safeToyId = toyId || "default-toy";
  const level = Math.max(0, Math.min(100, Math.round(Number(levelPercent) || 0)));

  toyControlState[safeToyId] = toyControlState[safeToyId] || { level: 0, specials: {} };
  toyControlState[safeToyId].level = level;

  const slider = els.toyControlList?.querySelector(`.toy-slider[data-toy-id="${safeToyId}"]`);
  if (slider instanceof HTMLInputElement) slider.value = String(level);
  updateToyPresetActive(safeToyId, level);

  if (level === 0) {
    clearToyThrottleState(safeToyId);
    flushToyIntensity(0, safeToyId, remote);
    return;
  }

  if (throttle) {
    scheduleVibrate(level, safeToyId, remote);
    return;
  }

  clearToyThrottleState(safeToyId);
  flushToyIntensity(level, safeToyId, remote);
}

function scheduleVibrate(levelPercent, toyId, remote) {
  const sendRemote = remote !== false;
  const safeToyId = toyId || "default-toy";
  const level = Math.max(0, Math.min(100, Number(levelPercent) || 0));

  if (level === 0) {
    clearAllToyPendingSends();
    flushToyIntensity(0, safeToyId, sendRemote);
    return;
  }

  const state = getToyThrottleState(safeToyId);
  const now = Date.now();
  const elapsed = now - state.lastSentAt;

  if (elapsed >= TOY_SLIDER_THROTTLE_MS) {
    state.lastSentAt = now;
    flushToyIntensity(level, safeToyId, sendRemote);
    return;
  }

  state.pending = { level, remote: sendRemote };
  if (state.trailingTimer) return;

  const waitMs = TOY_SLIDER_THROTTLE_MS - elapsed;
  state.trailingTimer = setTimeout(() => {
    state.trailingTimer = null;
    if (!state.pending) return;
    const pending = state.pending;
    state.pending = null;
    state.lastSentAt = Date.now();
    flushToyIntensity(pending.level, safeToyId, pending.remote);
  }, waitMs);
}

function updateToyPresetActive(toyId, activeLevelPercent) {
  if (!els.toyControlList || !toyId) return;
  const level = Math.max(0, Math.min(100, Number(activeLevelPercent) || 0));
  const activeValue =
    level > 0 && TOY_PRESET_LEVELS.some((p) => Number(p.value) === level) ? level : null;
  const buttons = els.toyControlList.querySelectorAll(`.toy-preset-btn[data-toy-id="${toyId}"]`);
  buttons.forEach((btn) => {
    const btnLevel = Number(btn.getAttribute("data-level") || 0);
    btn.classList.toggle("active", activeValue !== null && btnLevel === activeValue);
  });
}

function sendToySpecialPayload(toyId, special, checked) {
  if (!dataConn || !dataConn.open) {
    setDataActivityStatus("No data channel — connect first.", "err");
    return;
  }
  try {
    dataConn.send({
      type: "toy_special",
      toyId,
      special,
      enabled: !!checked,
      ts: Date.now(),
    });
    setDataActivityStatus(`${special} ${checked ? "enabled" : "disabled"} for ${toyId}.`, "ok");
  } catch (e) {
    setDataActivityStatus("Send failed: " + (e && e.message ? e.message : String(e)), "err");
  }
}

function renderToyControls(toys) {
  if (!els.toyControlList) return;
  const list = els.toyControlList;
  list.innerHTML = "";

  const toyList = Array.isArray(toys) && toys.length ? toys : getConnectedToys();
  toyList.forEach((toy, idx) => {
    const toyId = toy.id || `toy-${idx + 1}`;
    const toyName = toy.name || toy.type || `Toy ${idx + 1}`;
    if (!toyControlState[toyId]) {
      toyControlState[toyId] = { level: 0, specials: {} };
    }

    const block = document.createElement("section");
    block.className = "toy-block";
    block.dataset.toyId = toyId;

    const title = document.createElement("h3");
    title.className = "toy-block-title";
    title.textContent = toyName;
    block.appendChild(title);

    const btnRow = document.createElement("div");
    btnRow.className = "toy-preset-row";
    TOY_PRESET_LEVELS.forEach((preset) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "toy-preset-btn";
      b.textContent = preset.label;
      b.dataset.toyId = toyId;
      b.dataset.level = String(preset.value);
      if ((toyControlState[toyId].level || 0) > 0 && Number(preset.value) === Number(toyControlState[toyId].level)) {
        b.classList.add("active");
      }
      btnRow.appendChild(b);
    });
    block.appendChild(btnRow);

    const sliderWrap = document.createElement("div");
    sliderWrap.className = "toy-slider-row";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.value = String(Math.min(100, toyControlState[toyId].level || 0));
    slider.dataset.toyId = toyId;
    slider.className = "toy-slider";
    sliderWrap.appendChild(slider);
    block.appendChild(sliderWrap);

    const specialWrap = document.createElement("div");
    specialWrap.className = "toy-special-row";
    TOY_SPECIAL_COMMANDS.forEach((cmd) => {
      const id = `special-${toyId}-${cmd.id}`;
      const item = document.createElement("label");
      item.className = "toy-special-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = id;
      cb.dataset.toyId = toyId;
      cb.dataset.special = cmd.id;
      cb.checked = !!toyControlState[toyId].specials[cmd.id];
      const span = document.createElement("span");
      span.textContent = cmd.label;
      item.appendChild(cb);
      item.appendChild(span);
      specialWrap.appendChild(item);
    });
    block.appendChild(specialWrap);

    list.appendChild(block);
  });
}

function initDynamicToyControls() {
  if (!els.toyControlList) return;
  renderToyControls(getConnectedToys());

  els.toyControlList.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    if (!target.classList.contains("toy-preset-btn")) return;
    const toyId = target.dataset.toyId;
    const presetLevel = Math.min(100, Number(target.dataset.level || 0));
    if (!toyId) return;

    const level = target.classList.contains("active") ? 0 : presetLevel;
    applyToyIntensity(toyId, level, { throttle: false });
  });

  els.toyControlList.addEventListener("input", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.classList.contains("toy-slider")) return;
    const toyId = target.dataset.toyId;
    if (!toyId) return;
    const level = Math.max(0, Math.min(100, Number(target.value) || 0));
    applyToyIntensity(toyId, level, { throttle: level > 0 });
  });

  els.toyControlList.addEventListener("change", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.type !== "checkbox" || !target.dataset.special) return;
    const toyId = target.dataset.toyId;
    const special = target.dataset.special;
    if (!toyId || !special) return;
    toyControlState[toyId] = toyControlState[toyId] || { level: 0, specials: {} };
    toyControlState[toyId].specials[special] = target.checked;
    sendToySpecialPayload(toyId, special, target.checked);
  });
}

function formatChatTime(ts) {
  const d = new Date(ts || Date.now());
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function appendChatMessage(sender, text, isLocal, ts) {
  if (!els.chatMessages) {
    setDataActivityStatus("Chat container not found (#chat-messages).", "err");
    return;
  }
  const msg = document.createElement("div");
  msg.className = "chat-message" + (isLocal ? " local" : " remote");
  const safeText = String(text || "").trim();

  const meta = document.createElement("span");
  meta.className = "chat-meta";
  meta.textContent = `${sender} • ${formatChatTime(ts)}`;

  const textNode = document.createElement("span");
  textNode.className = "chat-text";
  textNode.textContent = safeText;

  msg.appendChild(meta);
  msg.appendChild(textNode);
  els.chatMessages.appendChild(msg);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function handleIncomingChatPayload(data) {
  if (!data || typeof data !== "object" || data.type !== "chat") return;
  const text = String(data.text || "").trim();
  if (!text) return;
  const sender = String(data.sender || "Partner");
  appendChatMessage(sender, text, false, data.ts);
}

function normalizeDataPayload(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return { type: "chat", text: raw };
    }
  }
  return null;
}

function handleIncomingDataMessage(raw) {
  const data = normalizeDataPayload(raw);
  if (!data) return;
  if (data.type === "toy") {
    handleIncomingToyPayload(data);
    return;
  }
  if (data.type === "toy_special") {
    handleIncomingToySpecialPayload(data);
    return;
  }
  if (data.type === "chat") {
    handleIncomingChatPayload(data);
    return;
  }
  setDataActivityStatus("Unknown data message received.", "err");
}

function sendChatMessage() {
  if (!els.chatInput || !els.chatMessages) {
    setDataActivityStatus("Chat UI not ready (#chat-input / #chat-messages).", "err");
    return;
  }
  const text = (els.chatInput.value || "").trim();
  if (!text) return;
  if (!dataConn || !dataConn.open) {
    setDataActivityStatus("Chat unavailable — connect first.", "err");
    return;
  }
  const sender = sessionRole === "host" ? "Host" : sessionRole === "guest" ? "Guest" : "You";
  const payload = {
    type: "chat",
    text,
    sender,
    ts: Date.now(),
  };
  try {
    // Show locally immediately so messages never disappear.
    appendChatMessage("You", text, true, payload.ts);
    els.chatInput.value = "";
    els.chatInput.focus();
    dataConn.send(payload);
    setDataActivityStatus("Chat message sent.", "ok");
  } catch (e) {
    setDataActivityStatus("Chat send failed: " + (e && e.message ? e.message : String(e)), "err");
  }
}

function initChatControls() {
  if (els.chatSend) {
    els.chatSend.type = "button";
    els.chatSend.addEventListener("click", sendChatMessage);
  }
  if (els.chatInput) {
    els.chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        sendChatMessage();
      }
    });
  }
}

function setLovenseStatus(text) {
  if (els.lovenseStatus) els.lovenseStatus.textContent = text || "";
}

function syncLovenseFromBridge() {
  const bridge = window.dualPeerLovense;
  if (!bridge) return;
  camExtensionInstance = bridge.instance || null;
  lovenseReady = !!bridge.ready;
}

function formatLovenseToys(toys) {
  if (!toys || !toys.length) return "No toy connected in the extension.";
  return toys
    .map((t) => `${t.type || "toy"}: ${t.status === "on" ? "on" : "off"}${t.battery ? ` (${t.battery}%)` : ""}`)
    .join(" · ");
}

function onLovenseReady(detail) {
  syncLovenseFromBridge();
  const ver = (detail && detail.version) || window.dualPeerLovense?.version;
  setLovenseStatus(
    `Extension ready${ver ? ` (v${ver})` : ""} — Site: ${window.dualPeerLovense?.getSiteName?.() || "test:Tangent-Club"}. Widget visible?`
  );
  if (els.lovenseToyStatus) {
    els.lovenseToyStatus.textContent = formatLovenseToys(
      (detail && detail.toys) || window.dualPeerLovense?.toys
    );
  }
  renderToyControls((detail && detail.toys) || window.dualPeerLovense?.toys);
}

function onLovenseError(detail) {
  syncLovenseFromBridge();
  lovenseReady = false;
  const msg =
    detail && detail.message
      ? detail.message
      : detail && detail.code
        ? String(detail.code)
        : "Unknown SDK error";
  setLovenseStatus("Lovense error: " + msg);
}

function onLovenseToys(toys) {
  if (els.lovenseToyStatus) els.lovenseToyStatus.textContent = formatLovenseToys(toys);
  renderToyControls(toys);
}

function initLovenseIfPresent() {
  syncLovenseFromBridge();

  if (els.lovenseUrlHint) {
    els.lovenseUrlHint.textContent =
      "Broadcast URL (must match Lovense dashboard): " + location.origin + location.pathname;
  }

  if (els.lovenseModelName) {
    els.lovenseModelName.value = window.__LOVENSE_MODEL_NAME__ || "model1";
    els.lovenseModelName.addEventListener("change", () => {
      window.__LOVENSE_MODEL_NAME__ = (els.lovenseModelName.value || "model1").trim() || "model1";
      setLovenseStatus("Model name changed — reload and reconnect the extension.");
    });
  }



  if (!window.dualPeerLovense) {
    setLovenseStatus("lovense-broadcast.js missing — check broadcast.js and lovense-broadcast.js.");
    return;
  }

  if (window.dualPeerLovense.ready) {
    onLovenseReady({ version: window.dualPeerLovense.version, toys: window.dualPeerLovense.toys });
  } else if (window.dualPeerLovense.error) {
    onLovenseError(window.dualPeerLovense.error);
  } else {
    setLovenseStatus(
      "SDK loaded — Chrome Cam Extension: select test:Tangent-Club, pair toys, and wait for 'ready'."
    );
  }

  document.addEventListener("dualpeer-lovense-ready", (e) => onLovenseReady(e.detail));
  document.addEventListener("dualpeer-lovense-error", (e) => onLovenseError(e.detail));
  document.addEventListener("dualpeer-lovense-toys", (e) => onLovenseToys(e.detail));
}

function handleIncomingToyPayload(data) {
  if (!data || typeof data !== "object") return;
  if (data.type !== "toy") return;

  const level = Math.max(0, Math.min(100, Number(data.level) || 0));
  const toyId = data.toyId || "default-toy";
  const name = data.tipperName || "Partner";

  if (level <= 0) {
    sendDirectVibration(0, toyId);
    setDataActivityStatus(`Stop received for ${toyId}.`, "ok");
    return;
  }

  pulseFor("local", 600 + level * 5);
  sendDirectVibration(level, toyId);
  setDataActivityStatus(`Intensity ${level}% received from ${name}.`, "ok");
}

function handleIncomingToySpecialPayload(data) {
  if (!data || typeof data !== "object" || data.type !== "toy_special") return;
  const toyId = data.toyId || "toy";
  const special = data.special || "special";
  const enabled = !!data.enabled;
  setDataActivityStatus(
    `Received special command ${special} ${enabled ? "enabled" : "disabled"} for ${toyId}.`,
    "ok"
  );
}

function setupDataConnection(conn) {
  dataConn = conn;
  updateConnectionUi();

  conn.on("data", handleIncomingDataMessage);
  conn.on("close", () => {
    dataConn = null;
    updateConnectionUi();
    setPeerStatus("Partner disconnected.", "err");
  });
  conn.on("open", () => {
    updateConnectionUi();
  });
  conn.on("error", (err) => {
    setDataActivityStatus(
      "Data channel error: " + (err && err.message ? err.message : String(err)),
      "err"
    );
  });

  if (conn.open) updateConnectionUi();
}

function onRemoteStream(remoteStream) {
  els.remoteVideo.srcObject = remoteStream;
  showPlaceholder(false, false);
  updateConnectionUi();
}

function setupPeerHandlers(stream) {
  peer.on("call", (call) => {
    call.answer(stream);
    mediaConn = call;
    call.on("stream", onRemoteStream);
    call.on("close", () => {
      showPlaceholder(false, true);
      updateConnectionUi();
    });
  });

  peer.on("connection", (conn) => {
    setupDataConnection(conn);
    updateConnectionUi();
  });

  peer.on("error", (err) => {
    setStatus(els.statusHost, String(err.message || err), "err");
    setStatus(els.statusGuest, String(err.message || err), "err");
  });
}

els.btnStartHost.addEventListener("click", async () => {
  hangup();
  sessionRole = "host";
  try {
    const stream = await getMedia();
    peer = new Peer(undefined, PEER_OPTIONS);

    peer.on("open", (id) => {
      els.peerIdOut.textContent = id;
      setupPeerHandlers(stream);
      setStatus(els.statusHost, "Waiting for incoming connection … share Peer ID with partner.", "ok");
      els.btnStartHost.disabled = true;
    });
  } catch (e) {
    setStatus(els.statusHost, "Camera/Microphone: " + e.message, "err");
  }
});

els.btnConnect.addEventListener("click", async () => {
  const remoteId = (els.peerIdIn.value || "").trim();
  if (!remoteId) {
    setStatus(els.statusGuest, "Please enter the host Peer ID.", "err");
    return;
  }
  hangup();
  sessionRole = "guest";
  try {
    const stream = await getMedia();
    peer = new Peer(undefined, PEER_OPTIONS);

    peer.on("open", (myId) => {
      els.peerIdOut.textContent = myId;
      setupPeerHandlers(stream);

      const call = peer.call(remoteId, stream);
      mediaConn = call;
      call.on("stream", onRemoteStream);
      call.on("close", () => {
        showPlaceholder(false, true);
        updateConnectionUi();
      });

      const conn = peer.connect(remoteId, { reliable: true });
      setupDataConnection(conn);

      updateConnectionUi();
      els.btnConnect.disabled = true;
      els.btnStartHost.disabled = true;
    });

    peer.on("error", (err) => {
      setStatus(els.statusGuest, String(err.message || err), "err");
    });
  } catch (e) {
    setStatus(els.statusGuest, "Camera/Microphone: " + e.message, "err");
  }
});

els.btnHangup.addEventListener("click", () => hangup());

window.addEventListener("beforeunload", () => hangup());

function setVideoAccessUi(unlocked) {
  videoAccessUnlocked = unlocked;
  document.body.classList.toggle("login-locked", !unlocked);
  document.querySelectorAll("body > header, body > main, body > footer").forEach((el) => {
    if (unlocked) el.removeAttribute("inert");
    else el.setAttribute("inert", "");
  });
  if (els.loginOverlay) {
    els.loginOverlay.hidden = unlocked;
  }
  if (els.btnStartHost) els.btnStartHost.disabled = !unlocked;
  if (els.btnConnect) els.btnConnect.disabled = !unlocked;
}

function initAccessGate() {
  const input = els.accessPassword;
  const btn = els.accessUnlock;
  const err = els.accessError;

  function showAccessErr(msg) {
    if (!err) return;
    err.textContent = msg || "";
    err.hidden = !msg;
  }

  function unlockFromGate() {
    showAccessErr("");
    try {
      sessionStorage.setItem(SESSION_VIDEO_UNLOCK_KEY, "1");
    } catch (_) {
      /* ignore */
    }
    setVideoAccessUi(true);
    if (input) input.value = "";
  }

  try {
    if (sessionStorage.getItem(SESSION_VIDEO_UNLOCK_KEY) === "1") {
      unlockFromGate();
      return;
    }
  } catch (_) {
    /* ignore */
  }

  setVideoAccessUi(false);

  if (btn) {
    btn.addEventListener("click", () => {
      const v = (input && input.value ? input.value : "").trim();
      if (v === VIDEO_ACCESS_PASSWORD) {
        unlockFromGate();
      } else {
        showAccessErr("Invalid password.");
        if (input) {
          input.value = "";
          input.focus();
        }
      }
    });
  }

  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && btn) btn.click();
    });
    requestAnimationFrame(() => input.focus());
  }
}

function initLogout() {
  const btn = els.logoutBtn;
  if (!btn) return;

  btn.addEventListener("click", () => {
    try {
      sessionStorage.removeItem(SESSION_VIDEO_UNLOCK_KEY);
    } catch (_) {
      /* ignore */
    }
    try {
      hangup();
    } catch (_) {
      /* ignore */
    }
    location.reload();
  });
}

function lovenseNotReadyMessage() {
  if (typeof CamExtension === "undefined") {
    return "broadcast.js not loaded.";
  }
  if (!window.dualPeerLovense) {
    return "lovense-broadcast.js not loaded.";
  }
  if (window.dualPeerLovense.error) {
    const e = window.dualPeerLovense.error;
    return (e.message || e.code || "SDK error") + " — check URL in Lovense dashboard.";
  }
  if (!camExtensionInstance) {
    return "CamExtension not initialized yet.";
  }
  if (!lovenseReady) {
    return "Extension not ready — in Chrome select test:Tangent-Club and verify widget on this page.";
  }
  return "Direct vibrate API is not available.";
}

function initHardwareTestControls() {
  const intensityRange = document.getElementById("intensityRange");
  const intensityValue = document.getElementById("intensityValue");
  if (intensityRange && intensityValue) {
    intensityRange.addEventListener("input", (e) => {
      const val = Math.max(0, Math.min(100, Number(e.target.value) || 0));
      intensityValue.textContent = val + "%";
      if (val === 0) {
        clearToyThrottleState("local-test");
        sendDirectVibration(0, "local-test");
      } else {
        scheduleVibrate(val, "local-test", false);
      }
    });
  }

  const testDevice = document.getElementById("testDevice");
  if (testDevice) {
    testDevice.addEventListener("click", () => {
      if (sendDirectVibration(80, "connection-test")) {
        alert("Direct vibrate test sent. Is the toy vibrating?");
      } else {
        alert("Lovense not ready: " + lovenseNotReadyMessage());
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initAccessGate();
  initLogout();
  initLayoutControls();
  initLovenseIfPresent();
  initChatControls();
  initDynamicToyControls();
  initHardwareTestControls();
});