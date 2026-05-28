/**
 * Dual-Peer-Demo: Video + DataChannel für Fern-Befehle.
 * Lovense: Wenn broadcast.js geladen ist und CamExtension bereit ist,
 * wird receiveTip() für den Empfänger aufgerufen (siehe index.html).
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
  toyLevel: $("#toyLevel"),
  toyTipAmount: $("#toyTipAmount"),
  toyTipName: $("#toyTipName"),
  btnSendToy: $("#btnSendToy"),
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

function isLovenseReady() {
  return (
    lovenseReady &&
    camExtensionInstance &&
    typeof camExtensionInstance.receiveTip === "function"
  );
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

/** Tip in Tokens (nicht 0-100 Intensität). Gibt true zurück, wenn receiveTip ausgeführt wurde. */
function fireLovenseTip(amount, tipperName) {
    const tokens = Math.round(Number(amount));
    if (!tokens || tokens < 1) return false;

    syncLovenseFromBridge();
    const bridge = window.dualPeerLovense;

    // HIER den try-Block öffnen: Er sichert alles ab, was danach kommt
    try {
        // 1. Prüfung: Gibt es die moderne Bridge-Schnittstelle?
        if (bridge && typeof bridge.receiveTip === "function") {
            const ok = bridge.receiveTip(tokens, tipperName || "Remote");
            if (ok) {
                console.log(`receiveTip: ${tokens} Tokens von ${tipperName || "Remote"}`);
                return true; 
            } else {
                console.warn("Lovense not ready — receiveTip queued or failed.");
                return false;
            }
        }

        // 2. Fallback: Falls 'bridge' nicht da ist, aber die alte 'camExtensionInstance' existiert
        if (typeof camExtensionInstance !== "undefined" && typeof camExtensionInstance.receiveTip === "function") {
            console.log(`Fallback receiveTip: ${tokens} Tokens von ${tipperName || "Remote"}`);
            camExtensionInstance.receiveTip(tokens, tipperName || "Remote");
            return true;
        }

        // Wenn weder Bridge noch alte Instanz gefunden wurden
        console.warn("Lovense extension is not ready or not installed.");
        return false;

    } catch (error) {
        // HIER am Ende des Blocks den Fehler abfangen, falls beim Aufruf etwas crasht
        console.error("Error while executing fireLovenseTip:", error);
        return false;
    }
}


function handleIncomingToyPayload(data) {
  if (!data || typeof data !== "object") return;
  if (data.type !== "toy") return;
  const level = Math.min(100, Math.max(0, Number(data.level) || 0));
  const tip = Number(data.tipAmount) || Math.max(1, Math.round(level / 5));
  const name = data.tipperName || "Partner";
  pulseFor("local", 600 + level * 5);

  const ok = fireLovenseTip(tip, name);
  const msg = ok
    ? `Received: ${tip} tokens from ${name}.`
    : `Received from ${name} — Lovense: ${lovenseNotReadyMessage()}`;
  setDataActivityStatus(msg, ok ? "ok" : "err");
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

els.btnSendToy.addEventListener("click", () => {
  if (!dataConn || !dataConn.open) {
    setDataActivityStatus("No data channel — connect first.", "err");
    return;
  }
  const level = Number(els.toyLevel.value) || 50;
  const tipAmount = Number(els.toyTipAmount.value) || 10;
  const tipperName = (els.toyTipName.value || "Partner").trim() || "Partner";

  try {
    dataConn.send({
      type: "toy",
      level,
      tipAmount,
      tipperName,
      ts: Date.now(),
    });
    setDataActivityStatus(`Sent: ${tipAmount} tokens to partner.`, "ok");
  } catch (e) {
    setDataActivityStatus("Send failed: " + (e && e.message ? e.message : String(e)), "err");
  }
});

document.querySelectorAll("[data-preset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const v = btn.getAttribute("data-preset");
    if (els.toyLevel) els.toyLevel.value = v;
  });
});

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
  return "receiveTip not available.";
}

function initHardwareTestControls() {
  const intensityRange = document.getElementById("intensityRange");
  const intensityValue = document.getElementById("intensityValue");
  if (intensityRange && intensityValue) {
    intensityRange.addEventListener("change", (e) => {
      const val = Number(e.target.value);
      intensityValue.textContent = val + "%";
      if (val <= 0) return;

      const tokens = Math.max(1, Math.round(val / 4));
      if (!fireLovenseTip(tokens, "Local-Test")) {
        console.warn("Hardware test:", lovenseNotReadyMessage());
      }
    });
  }
}

  const testDevice = document.getElementById("testDevice");
  if (testDevice) {
    testDevice.addEventListener("click", () => {
      if (fireLovenseTip(25, "Connection-Test")) {
        alert("Test signal (25 tokens) sent to Lovense. Is the toy vibrating?");
      } else {
        alert("Lovense not ready: " + lovenseNotReadyMessage());
      }
    });
  
}

// Funktion für das neue Muster-Dropdown
function sendPatternTest(patternType) {
  if (!patternType) return;
  const modelName = "model1";
  
  if (typeof lovense !== 'undefined' && lovense.sendAction) {
      lovense.sendAction({
          model: modelName,
          action: "pattern",
          rule: patternType
      });
  }
  document.getElementById('patternSelect').value = "";
}


// 1. Die Prozentanzeige live aktualisieren (OHNE Befehle an die Queue zu senden)
const slider = document.getElementById('selfControlSlider');
const intensityVal = document.getElementById('intensityVal');

if (slider && intensityVal) {
    slider.addEventListener('input', function() {
        intensityVal.innerText = this.value + '%';
    });
}

// 2. Funktion: Erst beim LOSLASSEN des Reglers wird GENAU EIN Befehl gesendet
function sendVibrationTest(intensity) {
    const modelName = "model1"; // Der feste Dummy-Wert für das Test-Setup
    
    console.log("Sende Einzel-Impuls mit Intensität: " + intensity + "%");
    
    // Prüft, ob die Lovense-Schnittstelle auf der Seite geladen ist
    if (typeof lovense !== 'undefined' && lovense.sendAction) {
        lovense.sendAction({
            model: modelName,
            action: "vibrate",
            vapi: parseInt(intensity)
        });
    }
}

// 3. Funktion: Ein ausgewähltes Muster (Special Command) an den Stream Master senden
function sendPatternTest(patternType) {
    if (!patternType) return;
    
    const modelName = "model1";
    console.log("Simuliere Special Command: " + patternType);
    
    if (typeof lovense !== 'undefined' && lovense.sendAction) {
        // Sendet den reinen Musternamen (z.B. "earthquake" oder "fireworks")
        lovense.sendAction({
            model: modelName,
            action: "pattern",
            rule: patternType
        });
    }
    
    // Setzt das Dropdown-Menü im Interface sofort wieder auf den Standardwert zurück
    document.getElementById('patternSelect').value = "";
}

document.addEventListener("DOMContentLoaded", () => {
  initAccessGate();
  initLogout();
  initLayoutControls();
  initLovenseIfPresent();
  initChatControls();
  initHardwareTestControls();
});