/**
 * Dual-Peer-Demo: Video + DataChannel für Fern-Befehle.
 * Lovense: Wenn broadcast.js geladen ist und CamExtension bereit ist,
 * wird receiveTip() für den Empfänger aufgerufen (siehe index.html).
 */

/** Zugang zur App (Video + Kamera-Buttons) — nur Demo, nicht als alleinige Absicherung nutzen. */
const VIDEO_ACCESS_PASSWORD = "Velvet_Touch";

const SESSION_VIDEO_UNLOCK_KEY = "dualpeer-app-session-v2";

/**
 * STUN/TURN für WebRTC (PeerJS übergibt dies an RTCPeerConnection).
 * Ersetze Host, Benutzername und Credential durch deinen TURN-Dienst (z. B. coturn, Twilio, Metered).
 */
const TURN_SERVER_HOST = "turn.example.com";
const TURN_USERNAME_PLACEHOLDER = "DEIN_TURN_BENUTZERNAME";
const TURN_CREDENTIAL_PLACEHOLDER = "DEIN_TURN_PASSWORT_ODER_SECRET";

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
  toyLevel: $("#toyLevel"),
  toyTipAmount: $("#toyTipAmount"),
  toyTipName: $("#toyTipName"),
  btnSendToy: $("#btnSendToy"),
  lovenseStatus: $("#lovenseStatus"),
  pipCorner: $("#pipCorner"),
  pipNativeMsg: $("#pipNativeMsg"),
  btnPipNativeRemote: $("#btnPipNativeRemote"),
  btnPipNativeLocal: $("#btnPipNativeLocal"),
  loginOverlay: $("#loginOverlay"),
  accessPassword: $("#accessPassword"),
  accessUnlock: $("#accessUnlock"),
  accessError: $("#accessError"),
};

let peer = null;
let localStream = null;
let mediaConn = null;
let dataConn = null;
let camExtensionInstance = null;

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
    setPipNativeMessage("Browser-PiP wird hier nicht unterstützt.");
  }

  async function toggleDocumentPip(video) {
    if (!document.pictureInPictureEnabled || !video) return;
    try {
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture();
        setPipNativeMessage("PiP-Fenster geschlossen.");
      } else {
        await video.requestPictureInPicture();
        setPipNativeMessage("PiP-Fenster aktiv (Tab kann im Hintergrund bleiben).");
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
  stopMedia();
  els.peerIdOut.textContent = "—";
  setStatus(els.statusHost, "Getrennt.");
  setStatus(els.statusGuest, "Getrennt.");
  els.btnStartHost.disabled = !videoAccessUnlocked;
  els.btnConnect.disabled = !videoAccessUnlocked;
}

function initLovenseIfPresent() {
  if (typeof CamExtension === "undefined") {
    if (els.lovenseStatus) {
      els.lovenseStatus.textContent =
        "Cam Extension SDK nicht geladen — nur Demo-Signale über WebRTC.";
    }
    return;
  }
  try {
    const site = window.__LOVENSE_SITE_NAME__ || "DualPeerDemo";
    const model = window.__LOVENSE_MODEL_NAME__ || "model1";
    // API: https://developer-api.lovense.com/docs/cam-solutions/cam-extension-for-chrome.html
    camExtensionInstance = new CamExtension(site, model);
    camExtensionInstance.on("ready", () => {
      if (els.lovenseStatus) {
        els.lovenseStatus.textContent =
          "Lovense Cam Extension bereit — receiveTip() löst Toy-Reaktionen aus (Extension + Connect).";
      }
    });
  } catch (e) {
    if (els.lovenseStatus) {
      els.lovenseStatus.textContent = "Lovense Init fehlgeschlagen: " + e.message;
    }
  }
}

function fireLovenseTip(amount, tipperName) {
  if (!camExtensionInstance || typeof camExtensionInstance.receiveTip !== "function") {
    return;
  }
  try {
    camExtensionInstance.receiveTip(Number(amount) || 1, tipperName || "Remote");
  } catch (_) {
    /* ignore */
  }
}

function handleIncomingToyPayload(data) {
  if (!data || typeof data !== "object") return;
  if (data.type !== "toy") return;
  const level = Math.min(100, Math.max(0, Number(data.level) || 0));
  const tip = Number(data.tipAmount) || Math.max(1, Math.round(level / 5));
  const name = data.tipperName || "Partner";
  pulseFor("local", 600 + level * 5);
  fireLovenseTip(tip, name);
}

function setupDataConnection(conn, isInitiator) {
  dataConn = conn;
  conn.on("data", handleIncomingToyPayload);
  conn.on("close", () => {
    dataConn = null;
  });
  if (isInitiator) {
    conn.on("open", () => setStatus(els.statusGuest, "Datenkanal offen — Fernsteuerung möglich.", "ok"));
  }
}

function setupPeerHandlers(stream) {
  peer.on("call", (call) => {
    call.answer(stream);
    mediaConn = call;
    call.on("stream", (remoteStream) => {
      els.remoteVideo.srcObject = remoteStream;
      showPlaceholder(false, false);
    });
    call.on("close", () => showPlaceholder(false, true));
  });

  peer.on("connection", (conn) => {
    setupDataConnection(conn, false);
    setStatus(els.statusHost, "Partner verbunden (Video + Steuerung).", "ok");
  });

  peer.on("error", (err) => {
    setStatus(els.statusHost, String(err.message || err), "err");
    setStatus(els.statusGuest, String(err.message || err), "err");
  });
}

els.btnStartHost.addEventListener("click", async () => {
  hangup();
  try {
    const stream = await getMedia();
    peer = new Peer(undefined, PEER_OPTIONS);

    peer.on("open", (id) => {
      els.peerIdOut.textContent = id;
      setupPeerHandlers(stream);
      setStatus(els.statusHost, "Warte auf eingehende Verbindung … Peer-ID an Partner senden.", "ok");
      els.btnStartHost.disabled = true;
    });
  } catch (e) {
    setStatus(els.statusHost, "Kamera/Mikro: " + e.message, "err");
  }
});

els.btnConnect.addEventListener("click", async () => {
  const remoteId = (els.peerIdIn.value || "").trim();
  if (!remoteId) {
    setStatus(els.statusGuest, "Bitte Peer-ID des Hosts eintragen.", "err");
    return;
  }
  hangup();
  try {
    const stream = await getMedia();
    peer = new Peer(undefined, PEER_OPTIONS);

    peer.on("open", (myId) => {
      els.peerIdOut.textContent = myId;
      setupPeerHandlers(stream);

      const call = peer.call(remoteId, stream);
      mediaConn = call;
      call.on("stream", (remoteStream) => {
        els.remoteVideo.srcObject = remoteStream;
        showPlaceholder(false, false);
      });
      call.on("close", () => showPlaceholder(false, true));

      const conn = peer.connect(remoteId, { reliable: true });
      setupDataConnection(conn, true);

      setStatus(els.statusGuest, "Verbindungsaufbau …", "ok");
      els.btnConnect.disabled = true;
      els.btnStartHost.disabled = true;
    });

    peer.on("error", (err) => {
      setStatus(els.statusGuest, String(err.message || err), "err");
    });
  } catch (e) {
    setStatus(els.statusGuest, "Kamera/Mikro: " + e.message, "err");
  }
});

els.btnHangup.addEventListener("click", () => hangup());

els.btnSendToy.addEventListener("click", () => {
  if (!dataConn || !dataConn.open) {
    setStatus(els.statusGuest, "Kein Datenkanal — zuerst verbinden.", "err");
    return;
  }
  const level = Number(els.toyLevel.value) || 50;
  const tipAmount = Number(els.toyTipAmount.value) || 10;
  const tipperName = (els.toyTipName.value || "Partner").trim() || "Partner";
  dataConn.send({
    type: "toy",
    level,
    tipAmount,
    tipperName,
    ts: Date.now(),
  });
  setStatus(els.statusGuest, "Befehl gesendet.", "ok");
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
        showAccessErr("Passwort ungültig.");
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

document.addEventListener("DOMContentLoaded", () => {
  initAccessGate();
  initLayoutControls();
  initLovenseIfPresent();
});
