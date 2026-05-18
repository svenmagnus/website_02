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
  sessionRole = null;
  stopMedia();
  els.peerIdOut.textContent = "—";
  setStatus(els.statusHost, "Getrennt.");
  setStatus(els.statusGuest, "Getrennt.");
  els.btnStartHost.disabled = !videoAccessUnlocked;
  els.btnConnect.disabled = !videoAccessUnlocked;
}

function setSessionStatus(msg, cls) {
  if (sessionRole === "host") {
    setStatus(els.statusHost, msg, cls);
  } else if (sessionRole === "guest") {
    setStatus(els.statusGuest, msg, cls);
  } else {
    setStatus(els.statusHost, msg, cls);
    setStatus(els.statusGuest, msg, cls);
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

function initLovenseIfPresent() {
  lovenseReady = false;
  if (typeof CamExtension === "undefined") {
    setLovenseStatus(
      "Cam Extension SDK nicht geladen — broadcast.js prüfen oder Netzwerk blockiert."
    );
    return;
  }
  try {
    const site = window.LOVENSE_SITE_NAME || "test:Tangent-Club";
    const model = window.__LOVENSE_MODEL_NAME__ || "model1";

    console.log("Initialisiere Lovense mit Site:", site, "Model:", model);
    setLovenseStatus(
      "Lovense SDK geladen — warte auf Chrome Cam Extension (Status: bereit) …"
    );
    camExtensionInstance = new CamExtension(site, model);

    camExtensionInstance.on("ready", (ce) => {
      lovenseReady = true;
      camExtensionInstance = ce || camExtensionInstance;
      console.log("Lovense Cam Extension ist bereit!", camExtensionInstance);
      setLovenseStatus(
        "Lovense Cam Extension bereit. Toys in der Extension verbinden, dann testen."
      );
    });
  } catch (e) {
    lovenseReady = false;
    setLovenseStatus("Lovense Init fehlgeschlagen: " + (e && e.message ? e.message : String(e)));
  }
}

/** Tip in Tokens (nicht 0–100 Intensität). Gibt true zurück, wenn receiveTip ausgeführt wurde. */
function fireLovenseTip(amount, tipperName) {
  const tokens = Math.round(Number(amount));
  if (!tokens || tokens < 1) return false;
  if (!isLovenseReady()) {
    console.warn("Lovense noch nicht bereit — receiveTip übersprungen.");
    return false;
  }
  try {
    console.log(`receiveTip: ${tokens} Tokens von ${tipperName || "Remote"}`);
    camExtensionInstance.receiveTip(tokens, tipperName || "Remote");
    return true;
  } catch (e) {
    console.error("Fehler beim Ausführen von receiveTip:", e);
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
    ? `Impuls von ${name} empfangen (${tip} Tokens).`
    : `Impuls von ${name} — Lovense: ${lovenseNotReadyMessage()}`;
  setSessionStatus(msg, ok ? "ok" : "err");
}

function setupDataConnection(conn) {
  dataConn = conn;
  conn.on("data", handleIncomingToyPayload);
  conn.on("close", () => {
    dataConn = null;
  });
  conn.on("open", () => {
    setSessionStatus("Datenkanal offen — Fernsteuerung in beide Richtungen möglich.", "ok");
  });
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
    setupDataConnection(conn);
    setStatus(els.statusHost, "Partner verbunden (Video + Steuerung).", "ok");
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
      setStatus(els.statusHost, "Werte auf eingehende Verbindung … Peer-ID an Partner senden.", "ok");
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
  sessionRole = "guest";
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
      setupDataConnection(conn);

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
    setSessionStatus("Kein Datenkanal — zuerst verbinden.", "err");
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
  setSessionStatus(`Impuls gesendet (${tipAmount} Tokens an Partner).`, "ok");
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
    return "broadcast.js nicht geladen.";
  }
  if (!camExtensionInstance) {
    return "CamExtension noch nicht initialisiert.";
  }
  if (!lovenseReady) {
    return "Chrome Cam Extension noch nicht verbunden — Extension öffnen, Site wählen, Toys koppeln.";
  }
  return "receiveTip nicht verfügbar.";
}

function initHardwareTestControls() {
  const intensityRange = document.getElementById("intensityRange");
  const intensityValue = document.getElementById("intensityValue");
  if (intensityRange && intensityValue) {
    intensityRange.addEventListener("input", (e) => {
      const val = Number(e.target.value);
      intensityValue.textContent = val + "%";
      if (val <= 0) return;

      const tokens = Math.max(1, Math.round(val / 4));
      if (!fireLovenseTip(tokens, "Local-Test")) {
        console.warn("Hardware-Test:", lovenseNotReadyMessage());
      }
    });
  }

  const testDevice = document.getElementById("testDevice");
  if (testDevice) {
    testDevice.addEventListener("click", () => {
      if (fireLovenseTip(25, "Connection-Test")) {
        alert("Test-Signal (25 Tokens) an Lovense gesendet! Vibriert das Toy?");
      } else {
        alert("Lovense noch nicht bereit: " + lovenseNotReadyMessage());
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initAccessGate();
  initLogout();
  initLayoutControls();
  initLovenseIfPresent();
  initHardwareTestControls();
});