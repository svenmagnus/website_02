/**
 * Dual-Peer demo: video + data channel for remote control.
 * Lovense: when broadcast.js is loaded and CamExtension is ready, receiveTip() runs locally.
 */

/** Browser global (app.js is not wrapped in an IIFE). */
const global = globalThis;

/** Site access unlocked after successful account login (see auth.js). */
const SESSION_VIDEO_UNLOCK_KEY = "dualpeer-app-session-v2";

// TURN example (OpenRelay placeholders — replace in production)
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

/**
 * Option A — Cloudflare quick tunnel → local WHIP server (port 8787).
 *
 * After each new tunnel, paste the https URL here (no trailing slash), commit & push
 * so www.tangent-club.com uses it. Localhost always uses :8787 directly.
 *
 * Terminal 1:  cd server && npm run restart
 * Terminal 2:  cd server && npm run tunnel
 */
/** Set in assets/api-config.js (loaded before app.js on auth pages). */
const WHIP_CLOUDFLARE_TUNNEL_URL =
  (typeof window !== "undefined" && window.WHIP_CLOUDFLARE_TUNNEL_URL) ||
  "https://tangent-club.com";

function isTangentClubSite() {
  return /(^|\.)tangent-club\.com$/i.test(location.hostname);
}

function isLocalDevHost() {
  return (
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.hostname === "[::1]"
  );
}

/** WHIP/WHEP API origin (browser + OBS ingest base). */
function resolveWhipApiBase() {
  if (window.DUALPEER_WHIP_URL) {
    return String(window.DUALPEER_WHIP_URL).replace(/\/$/, "");
  }
  if (location.port === "8787") {
    return location.origin;
  }
  if (isLocalDevHost()) {
    return `${location.protocol}//${location.hostname}:8787`;
  }
  if (isTangentClubSite()) {
    const tunnel = String(WHIP_CLOUDFLARE_TUNNEL_URL || "").trim().replace(/\/$/, "");
    if (tunnel && /^https:\/\//i.test(tunnel) && !/REPLACE|YOUR[-_]?SUBDOMAIN/i.test(tunnel)) {
      return tunnel;
    }
    return "";
  }
  return "http://127.0.0.1:8787";
}

function whipUnreachableMessage() {
  if (isTangentClubSite()) {
    const tunnel = String(WHIP_CLOUDFLARE_TUNNEL_URL || "").trim();
    if (!tunnel || /REPLACE|YOUR[-_]?SUBDOMAIN/i.test(tunnel)) {
      return (
        "WHIP tunnel URL missing: set WHIP_CLOUDFLARE_TUNNEL_URL in assets/app.js, " +
        "push to GitHub, then reload www.tangent-club.com."
      );
    }
    return (
      `WHIP server not reachable at ${tunnel.replace(/\/$/, "")}. ` +
      "On your Mac: cd server && npm run restart, then npm run tunnel (keep both running)."
    );
  }
  return "WHIP server not reachable. Run: cd server && npm run restart — then open http://127.0.0.1:8787/";
}

window.WHIP_CLOUDFLARE_TUNNEL_URL = WHIP_CLOUDFLARE_TUNNEL_URL;
window.DUALPEER_WHIP_URL = resolveWhipApiBase();
const WHIP_API_BASE = window.DUALPEER_WHIP_URL;

if (isTangentClubSite() && WHIP_API_BASE) {
  console.info("[WHIP] tangent-club.com → API", WHIP_API_BASE);
}

const $ = (sel) => document.querySelector(sel);

let videoAccessUnlocked = false;
let mediaPermissionGranted = false;

const els = {
  appMain: $("#appMain"),
  stage: $("#stage"),
  localVideo: $("#localVideo"),
  remoteVideo: $("#remoteVideo"),
  localPlaceholder: $("#localPlaceholder"),
  remotePlaceholder: $("#remotePlaceholder"),
  localPulse: $("#localPulse"),
  remotePulse: $("#remotePulse"),
  btnStartHost: $("#btnStartHost"),
  btnConnect: $("#btnConnect"),
  videoSourceSelect: $("#videoSourceSelect"),
  audioSourceSelect: $("#audioSourceSelect"),
  mediaSourceStatus: $("#mediaSourceStatus"),
  mediaSourceHint: $("#mediaSourceHint"),
  localToggleMuteBtn: $("#localToggleMuteBtn"),
  localToggleVideoBtn: $("#localToggleVideoBtn"),
  localMuteIcon: $("#localMuteIcon"),
  localVideoIcon: $("#localVideoIcon"),
  remoteToggleMuteBtn: $("#remoteToggleMuteBtn"),
  remoteToggleVideoBtn: $("#remoteToggleVideoBtn"),
  remoteMuteIcon: $("#remoteMuteIcon"),
  remoteVideoIcon: $("#remoteVideoIcon"),
  localVideoControls: document.querySelector('.video-media-overlay[data-panel="local"]'),
  remoteVideoControls: document.querySelector('.video-media-overlay[data-panel="remote"]'),
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
  lovenseSetupHint: $("#lovenseSetupHint"),
  localToyTestList: $("#localToyTestList"),
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

function notifySessionRole() {
  window.dispatchEvent(
    new CustomEvent("dualpeer-session-role", { detail: { role: sessionRole } })
  );
}

window.dualPeerSession = {
  getRole() {
    return sessionRole;
  },
  isHost() {
    return sessionRole === "host";
  },
};
let whipBroadcast = null;
let whipPollTimer = null;

const LAYOUT_STORAGE_KEY = "dualpeer-layout";
const CHAT_DOCK_STORAGE_KEY = "dualpeer-chat-dock";
const CHAT_WIDTH_STORAGE_KEY = "dualpeer-chat-width";
const STAGE_HEIGHT_STORAGE_KEY = "dualpeer-stage-height";
const VIDEO_DEVICE_STORAGE_KEY = "dualpeer-video-device";
const AUDIO_DEVICE_STORAGE_KEY = "dualpeer-audio-device";
const DEFAULT_LAYOUT = "split";
const CHAT_WIDTH_MIN = 260;
const CHAT_WIDTH_MAX = 720;
const STAGE_HEIGHT_MIN = 280;
const STAGE_HEIGHT_MAX = 920;

function setPipNativeMessage(text) {
  if (els.pipNativeMsg) els.pipNativeMsg.textContent = text || "";
}

function normalizeLayoutMode(mode) {
  if (mode === "pip-remote") return "pip-remote";
  return "split";
}

function hasActiveVideoFeed(video) {
  if (!video) return false;
  const wrap = video.closest(".video-wrap");
  if (wrap?.getAttribute("data-has-feed") === "true") return true;
  const stream = video.srcObject;
  if (stream && stream.getVideoTracks?.().some((t) => t.readyState === "live" && t.enabled && !t.muted)) {
    return true;
  }
  return video.readyState >= 2 && video.videoWidth > 0;
}

function getFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function resolveFullscreenTarget() {
  const layout = els.stage?.dataset.layout || "split";
  const hostWrap = document.getElementById("hostFsTarget");
  const guestWrap = document.getElementById("guestFsTarget");
  const remoteHasFeed = hasActiveVideoFeed(els.remoteVideo);
  const localHasFeed = hasActiveVideoFeed(els.localVideo);

  if (layout === "split") {
    if (remoteHasFeed && localHasFeed) {
      return {
        el: els.stage,
        video: els.remoteVideo,
        hint: document.getElementById("stageFsHint"),
      };
    }
    if (remoteHasFeed) {
      return { el: guestWrap, video: els.remoteVideo, hint: document.getElementById("guestFsHint") };
    }
    if (localHasFeed) {
      return { el: hostWrap, video: els.localVideo, hint: document.getElementById("hostFsHint") };
    }
    return {
      el: hostWrap || guestWrap || els.stage,
      video: els.localVideo || els.remoteVideo,
      hint: document.getElementById("hostFsHint") || document.getElementById("guestFsHint"),
    };
  }

  if (remoteHasFeed) {
    return { el: guestWrap, video: els.remoteVideo, hint: document.getElementById("guestFsHint") };
  }
  if (localHasFeed) {
    return { el: hostWrap, video: els.localVideo, hint: document.getElementById("hostFsHint") };
  }

  return {
    el: guestWrap || hostWrap,
    video: els.remoteVideo || els.localVideo,
    hint: document.getElementById("guestFsHint") || document.getElementById("hostFsHint"),
  };
}

function isMainFullscreenActive() {
  const fsEl = getFullscreenElement();
  if (!fsEl) {
    if (els.remoteVideo?.webkitDisplayingFullscreen) return true;
    if (els.localVideo?.webkitDisplayingFullscreen) return true;
    return false;
  }
  const targets = [
    els.stage,
    document.getElementById("hostFsTarget"),
    document.getElementById("guestFsTarget"),
    els.localVideo,
    els.remoteVideo,
  ].filter(Boolean);
  return targets.some((t) => t === fsEl || (t.contains && t.contains(fsEl)) || fsEl.contains(t));
}

function showFullscreenError(message) {
  const msg = message || "Fullscreen not available in this browser.";
  setPipNativeMessage(msg);
  console.warn("[fullscreen]", msg);
}

function requestElementFullscreen(el) {
  if (!el) throw new Error("No fullscreen target");
  if (typeof el.requestFullscreen === "function") {
    return el.requestFullscreen();
  }
  if (typeof el.webkitRequestFullscreen === "function") {
    return el.webkitRequestFullscreen();
  }
  throw new Error("Fullscreen API not supported");
}

function exitDocumentFullscreen() {
  if (typeof document.exitFullscreen === "function") {
    return document.exitFullscreen();
  }
  if (typeof document.webkitExitFullscreen === "function") {
    return document.webkitExitFullscreen();
  }
  return Promise.resolve();
}

function syncMainFullscreenUi(active) {
  document.querySelectorAll('[data-action="fullscreen-main"]').forEach((btn) => {
    btn.classList.toggle("active", active);
    const icon = btn.querySelector("i");
    if (icon) {
      icon.className = active ? "bi bi-fullscreen-exit" : "bi bi-fullscreen";
      icon.setAttribute("aria-hidden", "true");
    }
  });
  ["stageFsHint", "hostFsHint", "guestFsHint"].forEach((id) => {
    const hint = document.getElementById(id);
    if (hint) hint.hidden = true;
  });
  if (active) {
    const ctx = resolveFullscreenTarget();
    if (ctx.hint) ctx.hint.hidden = false;
  }
  document.body.classList.toggle("main-fullscreen-active", active);
}

function syncLayoutButtons(mode) {
  document.querySelectorAll(".stage-view-btn[data-layout]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-layout") === mode);
  });
}

async function exitMainFullscreenIfActive() {
  if (!isMainFullscreenActive()) return;
  try {
    await exitDocumentFullscreen();
  } catch (_) {
    /* ignore */
  }
  syncMainFullscreenUi(false);
}

function toggleMainFullscreen() {
  if (isMainFullscreenActive()) {
    exitDocumentFullscreen()
      .then(() => syncMainFullscreenUi(false))
      .catch((e) => showFullscreenError(e.message));
    return;
  }

  const ctx = resolveFullscreenTarget();
  const { el: target, video } = ctx;

  if (video && typeof video.webkitEnterFullscreen === "function" && /iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    try {
      video.webkitEnterFullscreen();
      syncMainFullscreenUi(true);
    } catch (e) {
      showFullscreenError(e.message);
    }
    return;
  }

  if (!target) {
    showFullscreenError("Video area not found.");
    return;
  }

  const tryTarget = (el, isFallback) => {
    requestElementFullscreen(el)
      .then(() => syncMainFullscreenUi(true))
      .catch((err) => {
        if (!isFallback && video && video !== el) {
          tryTarget(video, true);
          return;
        }
        showFullscreenError(err && err.message ? err.message : String(err));
      });
  };

  tryTarget(target, false);
}

function applyLayout(mode) {
  const m = normalizeLayoutMode(mode);
  exitMainFullscreenIfActive();

  if (els.stage) els.stage.dataset.layout = m;
  if (els.appMain) els.appMain.dataset.viewLayout = "default";

  if (m === "split") {
    applyChatDock("bottom-center");
    applyStageHeight(0, { skipStorage: true });
  } else {
    applyChatDock("right");
    applyStageHeight(undefined, { skipStorage: true });
    applyPipCorner("br");
  }

  syncLayoutButtons(m);
  updateResizeHandles();
  syncStageShellHeight();

  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, m);
  } catch (_) {
    /* ignore */
  }
}

function updateResizeHandles() {
  const main = els.appMain;
  const chatHandle = document.getElementById("chatResizeHandle");
  const rowHandle = document.getElementById("videoRowResizeHandle");
  if (!main) return;

  const dock = main.dataset.chatDock || "bottom-center";
  const showChatHandle = dock === "right";
  const layout = els.stage?.dataset.layout || "split";
  const showRowHandle = layout === "pip-remote";

  if (chatHandle) {
    chatHandle.classList.toggle("is-visible", showChatHandle);
    chatHandle.hidden = !showChatHandle;
  }
  if (rowHandle) rowHandle.hidden = !showRowHandle;
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

function applyChatDock(mode) {
  const allowed = ["right", "bottom", "bottom-center"];
  const m = allowed.includes(mode) ? mode : "right";
  const main = els.appMain;
  if (main) main.dataset.chatDock = m;

  const dockSelect = document.getElementById("chatDock");
  if (dockSelect instanceof HTMLSelectElement) {
    dockSelect.value = m;
  }

  try {
    localStorage.setItem(CHAT_DOCK_STORAGE_KEY, m);
  } catch (_) {
    /* ignore */
  }

  updateResizeHandles();
  syncStageShellHeight();
}

function syncStageShellHeight() {
  const main = els.appMain;
  const shell = document.querySelector(".stage-shell");
  if (!main) return;

  if (!shell || main.dataset.chatDock !== "right") {
    main.style.removeProperty("--cb-stage-shell-height");
    return;
  }

  main.style.setProperty("--cb-stage-shell-height", `${shell.offsetHeight}px`);
}

function applyChatWidth(px, options) {
  const opts = options || {};
  const main = els.appMain;
  if (!main) return;

  let width = Number(px);
  if (!Number.isFinite(width)) {
    try {
      width = Number(localStorage.getItem(CHAT_WIDTH_STORAGE_KEY)) || 360;
    } catch (_) {
      width = 360;
    }
  }

  width = Math.round(Math.min(CHAT_WIDTH_MAX, Math.max(CHAT_WIDTH_MIN, width)));
  main.style.setProperty("--cb-chat-width", `${width}px`);
  syncStageShellHeight();

  if (!opts.skipStorage) {
    try {
      localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, String(width));
    } catch (_) {
      /* ignore */
    }
  }
}

function applyStageHeight(px, options) {
  const opts = options || {};
  const main = els.appMain;
  if (!main) return;

  let height = Number(px);
  if (!Number.isFinite(height)) {
    try {
      height = Number(localStorage.getItem(STAGE_HEIGHT_STORAGE_KEY)) || 0;
    } catch (_) {
      height = 0;
    }
  }

  if (height > 0) {
    height = Math.round(Math.min(STAGE_HEIGHT_MAX, Math.max(STAGE_HEIGHT_MIN, height)));
    main.style.setProperty("--cb-stage-height", `${height}px`);
  } else {
    main.style.removeProperty("--cb-stage-height");
  }

  syncStageShellHeight();

  if (!opts.skipStorage && height > 0) {
    try {
      localStorage.setItem(STAGE_HEIGHT_STORAGE_KEY, String(height));
    } catch (_) {
      /* ignore */
    }
  }
}

function initStageRowResize() {
  const handle = document.getElementById("videoRowResizeHandle");
  const main = els.appMain;
  const stage = els.stage;
  if (!handle || !main || !stage) return;

  let dragging = false;

  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("is-dragging");
    document.body.classList.add("layout-resize-active-row");
    e.preventDefault();
  });

  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = stage.getBoundingClientRect();
    applyStageHeight(rect.height + e.movementY);
  });

  const stopDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("is-dragging");
    document.body.classList.remove("layout-resize-active-row");
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
  };

  handle.addEventListener("pointerup", stopDrag);
  handle.addEventListener("pointercancel", stopDrag);
}

function initChatResize() {
  const handle = document.getElementById("chatResizeHandle");
  const main = els.appMain;
  if (!handle || !main) return;

  let dragging = false;

  const onMove = (clientX) => {
    const rect = main.getBoundingClientRect();
    const width = rect.right - clientX;
    applyChatWidth(width);
  };

  handle.addEventListener("pointerdown", (e) => {
    if (main.dataset.chatDock !== "right") return;
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("is-dragging");
    document.body.classList.add("layout-resize-active");
    e.preventDefault();
  });

  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    onMove(e.clientX);
  });

  const stopDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("is-dragging");
    document.body.classList.remove("layout-resize-active");
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
  };

  handle.addEventListener("pointerup", stopDrag);
  handle.addEventListener("pointercancel", stopDrag);

  handle.addEventListener("keydown", (e) => {
    if (main.dataset.chatDock !== "right") return;
    let delta = 0;
    if (e.key === "ArrowLeft") delta = 16;
    if (e.key === "ArrowRight") delta = -16;
    if (!delta) return;
    e.preventDefault();
    const current = parseInt(getComputedStyle(main).getPropertyValue("--cb-chat-width"), 10) || 360;
    applyChatWidth(current + delta);
  });
}

function initStageViewControls() {
  const shell = document.querySelector(".stage-shell");
  if (!shell) return;

  shell.addEventListener(
    "click",
    (e) => {
      const btn = e.target instanceof Element ? e.target.closest(".stage-view-btn[data-layout]") : null;
      if (!btn || !shell.contains(btn)) return;
      e.preventDefault();
      e.stopPropagation();
      const mode = btn.getAttribute("data-layout");
      if (mode) applyLayout(mode);
    },
    true
  );
}

function initMainFullscreen() {
  const onFullscreenChange = () => {
    syncMainFullscreenUi(isMainFullscreenActive());
  };

  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);

  [els.remoteVideo, els.localVideo].forEach((video) => {
    if (!video) return;
    video.addEventListener("webkitbeginfullscreen", () => syncMainFullscreenUi(true));
    video.addEventListener("webkitendfullscreen", () => syncMainFullscreenUi(false));
  });

  document.addEventListener(
    "click",
    (e) => {
      const btn = e.target instanceof Element ? e.target.closest('[data-action="fullscreen-main"]') : null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      toggleMainFullscreen();
    },
    true
  );
}

function initStageShellHeightSync() {
  const shell = document.querySelector(".stage-shell");
  if (!shell) return;

  const ro = new ResizeObserver(() => syncStageShellHeight());
  ro.observe(shell);
  window.addEventListener("resize", syncStageShellHeight, { passive: true });
  syncStageShellHeight();
}

function initLayoutControls() {
  let saved = DEFAULT_LAYOUT;
  let corner = "br";
  try {
    saved = normalizeLayoutMode(localStorage.getItem(LAYOUT_STORAGE_KEY) || DEFAULT_LAYOUT);
    corner = localStorage.getItem("dualpeer-pip-corner") || "br";
  } catch (_) {
    /* ignore */
  }

  applyLayout(saved);
  if (normalizeLayoutMode(saved) === "split") {
    applyPipCorner(corner);
  }
  applyChatWidth(undefined, { skipStorage: true });
  initChatResize();
  initStageRowResize();
  initStageViewControls();
  initMainFullscreen();
  initStageShellHeightSync();

  applyStageHeight(undefined, { skipStorage: true });
  updateResizeHandles();
}

function setStatus(el, text, cls) {
  if (!el) return;
  el.textContent = text;
  el.className = "status-line" + (cls ? " " + cls : "");
}

function setVideoPlaceholderVisible(ph, visible) {
  if (!ph) return;
  ph.classList.toggle("is-visible", visible);
  ph.toggleAttribute("hidden", !visible);
  ph.setAttribute("aria-hidden", visible ? "false" : "true");
}

/** True when the video element is actually showing a camera/stream feed. */
function isVideoFeedActive(videoEl) {
  if (!videoEl?.srcObject) return false;

  if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
    return true;
  }

  const stream = videoEl.srcObject;
  if (!(stream instanceof MediaStream)) return false;

  return stream.getVideoTracks().some((t) => t.readyState !== "ended" && t.enabled && !t.muted);
}

function setVideoWrapFeedState(videoEl, active) {
  const wrap = videoEl?.closest(".video-wrap");
  if (!wrap) return;
  if (active) {
    wrap.setAttribute("data-has-feed", "true");
  } else {
    wrap.removeAttribute("data-has-feed");
  }
}

function scheduleOverlayRefreshBurst() {
  let frames = 0;
  const tick = () => {
    refreshVideoOverlays();
    if (++frames < 30) {
      requestAnimationFrame(tick);
    }
  };
  requestAnimationFrame(tick);
}

function bindVideoOverlayRefresh(videoEl) {
  if (!videoEl || videoEl._overlayRefreshBound) return;
  videoEl._overlayRefreshBound = true;
  const refresh = () => refreshVideoOverlays();
  videoEl.addEventListener("loadedmetadata", refresh);
  videoEl.addEventListener("loadeddata", refresh);
  videoEl.addEventListener("playing", refresh);
  videoEl.addEventListener("resize", refresh);
  videoEl.addEventListener("emptied", refresh);
}

function bindStreamTrackRefresh(stream) {
  if (!(stream instanceof MediaStream) || stream._overlayRefreshBound) return;
  stream._overlayRefreshBound = true;
  const refresh = () => refreshVideoOverlays();
  stream.getTracks().forEach((track) => {
    track.addEventListener("ended", refresh);
    track.addEventListener("mute", refresh);
    track.addEventListener("unmute", refresh);
  });
}

function refreshVideoOverlays() {
  const localPh = els.localPlaceholder || document.getElementById("localPlaceholder");
  const remotePh = els.remotePlaceholder || document.getElementById("remotePlaceholder");
  if (localPh && !els.localPlaceholder) els.localPlaceholder = localPh;
  if (remotePh && !els.remotePlaceholder) els.remotePlaceholder = remotePh;

  const localActive = isVideoFeedActive(els.localVideo);
  const remoteActive = isVideoFeedActive(els.remoteVideo);

  setVideoWrapFeedState(els.localVideo, localActive);
  setVideoWrapFeedState(els.remoteVideo, remoteActive);
  setVideoPlaceholderVisible(localPh, !localActive);
  setVideoPlaceholderVisible(remotePh, !remoteActive);
  syncRemoteMediaUi();
}

function pulseFor(side, ms = 800) {
  const pulse = side === "local" ? els.localPulse : els.remotePulse;
  if (!pulse) return;
  pulse.classList.add("active");
  clearTimeout(pulse._t);
  pulse._t = setTimeout(() => pulse.classList.remove("active"), ms);
}

function attachLocalVideoStream(stream) {
  if (!els.localVideo || !stream) return;
  els.localVideo.srcObject = stream;
  els.localVideo.muted = true;
  els.localVideo.setAttribute("muted", "");
  els.localVideo.defaultMuted = true;
  bindVideoOverlayRefresh(els.localVideo);
  bindStreamTrackRefresh(stream);
  stream.getVideoTracks().forEach((track) => {
    track.addEventListener("unmute", () => scheduleOverlayRefreshBurst());
  });
  const playPromise = els.localVideo.play();
  if (playPromise && typeof playPromise.then === "function") {
    playPromise.then(() => scheduleOverlayRefreshBurst()).catch(() => scheduleOverlayRefreshBurst());
  }
  scheduleOverlayRefreshBurst();
}

function setMediaSourceStatus(msg, cls) {
  if (!els.mediaSourceStatus) return;
  const text = msg || "";
  els.mediaSourceStatus.textContent = text;
  els.mediaSourceStatus.hidden = !text;
  els.mediaSourceStatus.className = "status-line" + (cls ? " " + cls : "");
}

function getSavedMediaDeviceId(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch (_) {
    return "";
  }
}

function saveMediaDeviceSelection() {
  const videoId = els.videoSourceSelect?.value || "";
  const audioId = els.audioSourceSelect?.value || "";
  try {
    if (videoId) localStorage.setItem(VIDEO_DEVICE_STORAGE_KEY, videoId);
    else localStorage.removeItem(VIDEO_DEVICE_STORAGE_KEY);
    if (audioId) localStorage.setItem(AUDIO_DEVICE_STORAGE_KEY, audioId);
    else localStorage.removeItem(AUDIO_DEVICE_STORAGE_KEY);
  } catch (_) {
    /* ignore */
  }
}

function isObsVirtualCameraLabel(label) {
  return /obs(\s*virtual\s*camera|\s*camera)?/i.test(String(label || ""));
}

function isObsDevice(device) {
  return !!(device && isObsVirtualCameraLabel(device.label));
}

function isObsDeviceSelected() {
  const select = els.videoSourceSelect;
  if (!(select instanceof HTMLSelectElement)) return false;
  const opt = select.selectedOptions[0];
  return isObsVirtualCameraLabel(opt?.textContent || "") || isObsVirtualCameraLabel(opt?.label);
}

function setObsVideoWrapFlag(isObs) {
  const wrap = els.localVideo?.closest(".video-wrap");
  if (!wrap) return;
  if (isObs) wrap.setAttribute("data-obs-source", "true");
  else wrap.removeAttribute("data-obs-source");
}

async function findSelectedVideoDevice() {
  if (!navigator.mediaDevices?.enumerateDevices) return null;
  await ensureMediaPermission();
  const videoInputs = (await navigator.mediaDevices.enumerateDevices()).filter(
    (d) => d.kind === "videoinput"
  );
  const selectedId = els.videoSourceSelect?.value || getSavedMediaDeviceId(VIDEO_DEVICE_STORAGE_KEY);

  if (selectedId) {
    const byId = videoInputs.find((d) => d.deviceId === selectedId);
    if (byId) return byId;
  }

  const obs = videoInputs.find((d) => isObsVirtualCameraLabel(d.label));
  if (obs) {
    if (els.videoSourceSelect instanceof HTMLSelectElement) {
      els.videoSourceSelect.value = obs.deviceId;
      saveMediaDeviceSelection();
    }
    return obs;
  }

  return null;
}

function buildVideoConstraints(device) {
  if (!device) {
    return { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } };
  }
  if (isObsDevice(device)) {
    return {
      deviceId: { ideal: device.deviceId },
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 30, max: 60 },
    };
  }
  return {
    deviceId: { ideal: device.deviceId },
    width: { ideal: 1280 },
    height: { ideal: 720 },
  };
}

function buildAudioConstraints() {
  const audioId = els.audioSourceSelect?.value || getSavedMediaDeviceId(AUDIO_DEVICE_STORAGE_KEY);
  return audioId ? { deviceId: { ideal: audioId } } : true;
}

async function acquireUserMediaStream() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera access not supported in this browser.");
  }

  const videoDevice = await findSelectedVideoDevice();
  const isObs = isObsDevice(videoDevice);
  const videoBase = buildVideoConstraints(videoDevice);
  const audio = buildAudioConstraints();

  const attempts = [
    { video: videoBase, audio },
    isObs && videoDevice
      ? { video: { deviceId: { ideal: videoDevice.deviceId } }, audio }
      : null,
    videoDevice
      ? { video: { deviceId: { exact: videoDevice.deviceId } }, audio }
      : null,
    isObs && videoDevice
      ? { video: { deviceId: { ideal: videoDevice.deviceId } }, audio: false }
      : null,
  ].filter(Boolean);

  let lastErr = null;
  for (const constraints of attempts) {
    try {
      let stream = await navigator.mediaDevices.getUserMedia(constraints);

      if (constraints.audio === false) {
        try {
          const audioStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
          audioStream.getAudioTracks().forEach((track) => stream.addTrack(track));
        } catch (_) {
          /* video-only OBS stream is still usable */
        }
      }

      setObsVideoWrapFlag(isObs);
      if (isObs) {
        setMediaSourceStatus(
          "OBS Virtual Camera active — your scene should appear in the You/Host panel.",
          "ok"
        );
      }
      return stream;
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("Could not open the selected camera.");
}

function buildMediaConstraints() {
  const videoId = els.videoSourceSelect?.value || getSavedMediaDeviceId(VIDEO_DEVICE_STORAGE_KEY);
  const audioId = els.audioSourceSelect?.value || getSavedMediaDeviceId(AUDIO_DEVICE_STORAGE_KEY);

  const video = videoId
    ? { deviceId: { ideal: videoId }, width: { ideal: 1280 }, height: { ideal: 720 } }
    : { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } };

  const audio = audioId ? { deviceId: { ideal: audioId } } : true;
  return { video, audio };
}

async function ensureMediaPermission() {
  if (mediaPermissionGranted || !navigator.mediaDevices?.getUserMedia) return mediaPermissionGranted;
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    probe.getTracks().forEach((track) => track.stop());
    mediaPermissionGranted = true;
    return true;
  } catch (_) {
    return false;
  }
}

function populateDeviceSelect(selectEl, devices, savedId, emptyLabel) {
  if (!(selectEl instanceof HTMLSelectElement)) return "";
  const prev = selectEl.value || savedId || "";
  selectEl.innerHTML = "";

  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = emptyLabel;
  selectEl.appendChild(defaultOpt);

  devices.forEach((device) => {
    const opt = document.createElement("option");
    opt.value = device.deviceId;
    opt.textContent = device.label || `${device.kind} (${device.deviceId.slice(0, 8)}…)`;
    if (isObsVirtualCameraLabel(device.label)) {
      opt.textContent = device.label ? `${device.label} (OBS)` : "OBS Virtual Camera";
    }
    selectEl.appendChild(opt);
  });

  if (prev && [...selectEl.options].some((opt) => opt.value === prev)) {
    selectEl.value = prev;
  }
  return selectEl.value;
}

async function refreshMediaDeviceLists() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    setMediaSourceStatus("Device list not supported in this browser.", "err");
    return false;
  }

  const permitted = await ensureMediaPermission();
  if (!permitted) {
    setMediaSourceStatus("Allow camera and microphone to list video sources (incl. OBS).", "err");
    return false;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoInputs = devices.filter((d) => d.kind === "videoinput");
  const audioInputs = devices.filter((d) => d.kind === "audioinput");
  const savedVideoId = getSavedMediaDeviceId(VIDEO_DEVICE_STORAGE_KEY);
  const savedAudioId = getSavedMediaDeviceId(AUDIO_DEVICE_STORAGE_KEY);
  const obsCamera = videoInputs.find((d) => isObsVirtualCameraLabel(d.label));

  populateDeviceSelect(els.videoSourceSelect, videoInputs, savedVideoId, "Default camera");
  populateDeviceSelect(els.audioSourceSelect, audioInputs, savedAudioId, "Default microphone");

  saveMediaDeviceSelection();

  const mode = getBroadcastMode();
  if (obsCamera && mode === "camera") {
    setMediaSourceStatus(
      "OBS Virtual Camera erkannt — optional oben wählen. Oder eine normale Webcam.",
      "ok"
    );
  } else if (videoInputs.length) {
    setMediaSourceStatus(
      `${videoInputs.length} camera(s) ready — pick a source, then Start Camera.`,
      "ok"
    );
  } else {
    setMediaSourceStatus(
      "Keine Kamera gefunden — Browser-Zugriff erlauben oder OBS Virtual Camera starten.",
      "err"
    );
  }

  return true;
}

function replaceTracksInPeerConnection(stream) {
  const pc = mediaConn?.peerConnection;
  if (!pc || !stream) return;
  stream.getTracks().forEach((track) => {
    const sender = pc.getSenders().find((s) => s.track?.kind === track.kind);
    if (sender) sender.replaceTrack(track).catch(() => {});
  });
}

function replaceTrackInPeerConnection(newTrack) {
  const pc = mediaConn?.peerConnection;
  if (!pc || !newTrack) return;
  pc.getSenders().forEach((sender) => {
    if (sender.track?.kind === newTrack.kind) {
      sender.replaceTrack(newTrack).catch(() => {});
    }
  });
}

async function swapLocalMediaTrack(kind, deviceId) {
  if (!localStream) return;

  let fresh;
  if (kind === "video") {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const device =
      devices.find((d) => d.kind === "videoinput" && d.deviceId === deviceId) ||
      devices.find((d) => d.kind === "videoinput" && isObsVirtualCameraLabel(d.label));
    const constraints = { video: buildVideoConstraints(device || null), audio: false };
    fresh = await navigator.mediaDevices.getUserMedia(constraints);
    setObsVideoWrapFlag(isObsDevice(device));
  } else {
    fresh = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: deviceId ? { deviceId: { ideal: deviceId } } : true,
    });
  }

  const newTrack = fresh.getTracks()[0];
  if (!newTrack) {
    fresh.getTracks().forEach((track) => track.stop());
    return;
  }

  const oldTrack = localStream.getTracks().find((track) => track.kind === kind);
  if (oldTrack) {
    localStream.removeTrack(oldTrack);
    oldTrack.stop();
  }
  localStream.addTrack(newTrack);
  fresh.getTracks().forEach((track) => {
    if (track !== newTrack) track.stop();
  });

  replaceTrackInPeerConnection(newTrack);
  window.localStream = localStream;
  attachLocalVideoStream(localStream);
  refreshVideoOverlays();
  syncLocalMediaUi();
}

async function applySelectedMediaDevices() {
  saveMediaDeviceSelection();
  if (!localStream) return;

  const videoId = els.videoSourceSelect?.value || "";
  const audioId = els.audioSourceSelect?.value || "";
  const currentVideoId = localStream.getVideoTracks()[0]?.getSettings()?.deviceId || "";
  const currentAudioId = localStream.getAudioTracks()[0]?.getSettings()?.deviceId || "";

  try {
    if (videoId !== currentVideoId) {
      await swapLocalMediaTrack("video", videoId);
    }
    if (audioId !== currentAudioId) {
      await swapLocalMediaTrack("audio", audioId);
    }
    setMediaSourceStatus("Media source updated.", "ok");
  } catch (e) {
    setMediaSourceStatus(formatMediaAccessError(e), "err");
  }
}

function setMediaSourceControlsEnabled(enabled) {
  [els.videoSourceSelect, els.audioSourceSelect, document.getElementById("broadcastMode")].forEach((el) => {
    if (el) el.disabled = !enabled;
  });
  syncBroadcastModeUi();
}

function getBroadcastMode() {
  const sel = document.getElementById("broadcastMode");
  return sel instanceof HTMLSelectElement && sel.value === "whip" ? "whip" : "camera";
}

function syncBroadcastModeUi() {
  const mode = getBroadcastMode();
  const whipPanel = document.getElementById("whipBroadcastPanel");
  const hint = document.getElementById("mediaSourceHint");
  document.querySelectorAll(".media-source-row").forEach((row) => {
    if (row.querySelector("#broadcastMode")) return;
    row.hidden = mode === "whip";
  });
  if (whipPanel) whipPanel.hidden = mode !== "whip";
  if (hint) {
    hint.textContent =
      mode === "whip"
        ? "OBS mode: after Start Camera, paste WHIP details into OBS and start streaming. For webcam only: choose Webcam & microphone."
        : "Webcam mode: pick camera and microphone above, then Start Camera — no OBS required. Optional: OBS Virtual Camera as video source.";
  }
}

function updateWhipBroadcastUi(message, cls) {
  const server = document.getElementById("whipServerOut");
  const bearer = document.getElementById("whipBearerOut");
  const status = document.getElementById("whipBroadcastStatus");
  const serverUrl =
    whipBroadcast?.whipServerUrl || whipBroadcast?.whipUrl?.replace(/\/[^/]+$/, "") || "";
  const bearerToken = whipBroadcast?.whipBearerToken || whipBroadcast?.streamKey || "";
  if (server) server.textContent = serverUrl || "—";
  if (bearer) bearer.textContent = bearerToken || "—";
  syncWhipCopyButtons();
  if (status && message) {
    status.textContent = message;
    status.className = "status-line" + (cls ? " " + cls : "");
  }
}

function syncWhipCopyButtons() {
  const serverVal = document.getElementById("whipServerOut")?.textContent?.trim() || "";
  const bearerVal = document.getElementById("whipBearerOut")?.textContent?.trim() || "";
  const btnServer = document.getElementById("btnCopyWhipServer");
  const btnBearer = document.getElementById("btnCopyWhipBearer");
  const hasServer = serverVal && serverVal !== "—";
  const hasBearer = bearerVal && bearerVal !== "—";
  if (btnServer) btnServer.disabled = !hasServer;
  if (btnBearer) btnBearer.disabled = !hasBearer;
}

async function copyWhipField(valueElId, feedbackElId) {
  const valueEl = document.getElementById(valueElId);
  const feedbackEl = document.getElementById(feedbackElId);
  const text = (valueEl?.textContent || "").trim();
  if (!text || text === "—") return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
  if (feedbackEl) {
    feedbackEl.hidden = false;
    clearTimeout(feedbackEl._copyTimer);
    feedbackEl._copyTimer = setTimeout(() => {
      feedbackEl.hidden = true;
    }, 1600);
  }
}

function initWhipCopyButtons() {
  document.getElementById("btnCopyWhipServer")?.addEventListener("click", () => {
    copyWhipField("whipServerOut", "whipServerCopyFeedback");
  });
  document.getElementById("btnCopyWhipBearer")?.addEventListener("click", () => {
    copyWhipField("whipBearerOut", "whipBearerCopyFeedback");
  });
  syncWhipCopyButtons();
}

async function checkWhipServerReachable() {
  try {
    const resp = await fetch(`${WHIP_API_BASE}/health`, { cache: "no-store" });
    return resp.ok;
  } catch (_) {
    return false;
  }
}

async function registerWhipBroadcast(peerId) {
  if (!WHIP_API_BASE) {
    throw new Error(whipUnreachableMessage());
  }
  const reachable = await checkWhipServerReachable();
  if (!reachable) {
    throw new Error(whipUnreachableMessage());
  }
  const resp = await fetch(`${WHIP_API_BASE}/api/broadcast/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ peerId: peerId || "" }),
  });
  if (!resp.ok) {
    throw new Error(
      `WHIP register failed (${resp.status}). Is the server running and is the Cloudflare tunnel active?`
    );
  }
  whipBroadcast = await resp.json();
  updateWhipBroadcastUi(
    "OBS: paste Server + Bearer Token (Settings → Stream → WHIP), then Start Streaming.",
    "ok"
  );
  return whipBroadcast;
}

function waitForWhipLive(streamKey, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    clearInterval(whipPollTimer);
    whipPollTimer = setInterval(async () => {
      try {
        const resp = await fetch(`${WHIP_API_BASE}/api/broadcast/${encodeURIComponent(streamKey)}/status`);
        const data = await resp.json();
        const state = data.connectionState || "waiting";
        if (data.videoRtp) {
          clearInterval(whipPollTimer);
          updateWhipBroadcastUi("OBS video active — loading stream into Host panel…", "ok");
          resolve(data);
          return;
        }
        if (data.tracksReady && data.whipIngest) {
          updateWhipBroadcastUi(
            `OBS connected (${state}, ${data.trackCount} tracks) — waiting for video data…`,
            "ok"
          );
        } else if (data.whipIngest) {
          updateWhipBroadcastUi(
            `OBS reached server (${state}, ${data.trackCount} tracks). Waiting for video…`,
            "ok"
          );
        } else {
          updateWhipBroadcastUi(
            "Waiting for OBS WHIP… paste URL in OBS → Settings → Stream → WHIP → Start Streaming",
            ""
          );
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(whipPollTimer);
          reject(new Error("Timed out waiting for OBS WHIP stream."));
        }
      } catch (err) {
        clearInterval(whipPollTimer);
        reject(err);
      }
    }, 1500);
  });
}

function waitIceGatheringCompleteBrowser(pc, timeoutMs = 4000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }
    function onChange() {
      if (pc.iceGatheringState === "complete") finish();
    }
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

function waitForPeerConnected(pc, timeoutMs = 20000) {
  if (pc.connectionState === "connected") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebRTC video connection timed out.")), timeoutMs);
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "connected") {
        clearTimeout(timer);
        resolve();
      }
      if (pc.connectionState === "failed") {
        clearTimeout(timer);
        reject(new Error("WebRTC connection failed."));
      }
    });
  });
}

async function subscribeWhepStream(whepUrl) {
  let lastErr = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await subscribeWhepStreamOnce(whepUrl);
    } catch (err) {
      lastErr = err;
      if (attempt < 7) {
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
  }
  throw lastErr || new Error("WHEP subscribe failed");
}

async function subscribeWhepStreamOnce(whepUrl) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  const stream = new MediaStream();
  pc.addEventListener("track", (event) => {
    if (event.track && !stream.getTracks().includes(event.track)) {
      stream.addTrack(event.track);
    }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceGatheringCompleteBrowser(pc, 6000);

  const resp = await fetch(whepUrl, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: pc.localDescription.sdp,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || "WHEP subscribe failed");
  }

  const answerSdp = await resp.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  await waitForPeerConnected(pc);

  if (!stream.getVideoTracks().length) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("No video track from OBS WHIP.")), 12000);
      pc.addEventListener("track", (event) => {
        if (event.track?.kind === "video") stream.addTrack(event.track);
        if (stream.getVideoTracks().length) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }

  stream._whepPc = pc;
  return stream;
}

async function waitForWhepVideoFrames(stream, videoEl, timeoutMs = 20000) {
  const vt = stream.getVideoTracks()[0];
  if (!vt) throw new Error("No video track from OBS WHIP.");

  if (videoEl?.videoWidth > 0) return;
  if (!vt.muted) return;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("OBS video is black — no frames received. Reconnect OBS with a fresh Bearer Token.")),
      timeoutMs
    );
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    if (videoEl) {
      videoEl.addEventListener("loadeddata", done, { once: true });
      videoEl.addEventListener(
        "resize",
        () => {
          if (videoEl.videoWidth > 0) done();
        },
        { once: true }
      );
    }
    vt.onunmute = done;
  });
}

async function startWhipSessionMedia() {
  if (!whipBroadcast?.streamKey) {
    await registerWhipBroadcast("");
  }
  await waitForWhipLive(whipBroadcast.streamKey);

  if (localStream) {
    if (localStream._whepPc) {
      try {
        localStream._whepPc.close();
      } catch (_) {
        /* ignore */
      }
    }
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }

  localStream = await subscribeWhepStream(whipBroadcast.whepUrl);
  window.localStream = localStream;
  attachLocalVideoStream(localStream);
  updateWhipBroadcastUi("WHEP connected — waiting for OBS video frames…", "ok");
  await waitForWhepVideoFrames(localStream, els.localVideo);
  if (mediaConn) replaceTracksInPeerConnection(localStream);
  refreshVideoOverlays();
  syncLocalMediaUi();
  setObsVideoWrapFlag(false);
  setMediaSourceStatus("OBS WHIP scene active in Host panel.", "ok");
  updateWhipBroadcastUi("Live — guest receives your OBS scene via PeerJS.", "ok");
  return localStream;
}

async function startSessionMedia() {
  if (getBroadcastMode() === "whip") {
    return startWhipSessionMedia();
  }
  await refreshMediaDeviceLists();
  await getMedia({ forceNew: true });
  if (isObsDeviceSelected()) {
    scheduleObsCaptureRetry();
  }
  return getActiveLocalStream();
}

let obsCaptureRetryTimer = null;

function scheduleObsCaptureRetry() {
  clearTimeout(obsCaptureRetryTimer);
  obsCaptureRetryTimer = setTimeout(async () => {
    if (!sessionRole || !isObsDeviceSelected()) return;
    try {
      await getMedia({ forceNew: true });
      replaceTracksInPeerConnection(getActiveLocalStream());
      setMediaSourceStatus("OBS stream refreshed.", "ok");
    } catch (_) {
      /* keep first capture */
    }
  }, 1200);
}

function initMediaSourceControls() {
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => {
      if (!videoAccessUnlocked) return;
      refreshMediaDeviceLists()
        .then(() => {
          if (localStream && isObsDeviceSelected() && sessionRole) {
            return getMedia({ forceNew: true }).then(() => {
              replaceTracksInPeerConnection(getActiveLocalStream());
            });
          }
          return null;
        })
        .catch(() => {});
    });
  }

  const onDeviceChange = () => {
    saveMediaDeviceSelection();
    if (localStream) {
      applySelectedMediaDevices().catch(() => {});
    }
  };

  if (els.videoSourceSelect) els.videoSourceSelect.addEventListener("change", onDeviceChange);
  if (els.audioSourceSelect) els.audioSourceSelect.addEventListener("change", onDeviceChange);

  const broadcastMode = document.getElementById("broadcastMode");
  if (broadcastMode) {
    broadcastMode.addEventListener("change", () => {
      syncBroadcastModeUi();
      refreshMediaDeviceLists().catch(() => {});
    });
  }
  syncBroadcastModeUi();
  initWhipCopyButtons();
}

async function getMedia(options = {}) {
  const forceNew = !!(options && options.forceNew);
  if (localStream && !forceNew) {
    window.localStream = localStream;
    attachLocalVideoStream(localStream);
    refreshVideoOverlays();
    syncLocalMediaUi();
    return localStream;
  }

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
    window.localStream = null;
  }

  localStream = await acquireUserMediaStream();
  window.localStream = localStream;
  attachLocalVideoStream(localStream);
  refreshVideoOverlays();
  syncLocalMediaUi();
  mediaPermissionGranted = true;
  return localStream;
}

function stopMedia() {
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  window.localStream = null;
  setObsVideoWrapFlag(false);
  resetLocalMediaUi();
  resetRemoteMediaUi();
  els.localVideo.srcObject = null;
  els.remoteVideo.srcObject = null;
  refreshVideoOverlays();
}

function clearLiveChatDom() {
  if (els.chatMessages) els.chatMessages.replaceChildren();
}

function endSessionChat() {
  clearLiveChatDom();
  global.DualPeerSocial?.clearChatAfterSession?.().catch(() => {});
}

function hangup() {
  const wasStreamProvider = sessionRole === "host";
  const hadLiveCall = !!(dataConn?.open || mediaConn?.open);
  if (dataConn?.open) {
    try {
      sendDataChannelMessage({ type: "session_end" });
    } catch (_) {
      /* ignore */
    }
  }
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
  notifySessionRole();
  global.DualPeerSocial?.updateSessionActionHighlight?.();
  partnerRemoteToys = [];
  renderToyControls([]);
  clearTimeout(obsCaptureRetryTimer);
  clearInterval(whipPollTimer);
  whipPollTimer = null;
  whipBroadcast = null;
  if (localStream?._whepPc) {
    try {
      localStream._whepPc.close();
    } catch (_) {
      /* ignore */
    }
  }
  stopMedia();
  els.peerIdOut.textContent = "—";
  resetConnectionLabels();
  if (wasStreamProvider) {
    global.DualPeerSocial?.endLiveSession?.().catch(() => {});
  }
  if (hadLiveCall) endSessionChat();
  if (videoAccessUnlocked) applyAccountStreamingUi();
  else {
    if (els.btnStartHost) els.btnStartHost.disabled = true;
    if (els.btnConnect) els.btnConnect.disabled = true;
  }
}

function resetConnectionLabels() {
  setStatus(els.statusHost, "Your camera: not started yet.");
  setStatus(els.statusGuest, "Partner stream: not connected yet.");
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
  syncStreamTabStatus();
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

/** Slider % per button; motor 5→10→15→18→20 (Ultra = full, Max one step below). */
const TOY_PRESET_LEVELS = [
  { label: "Low", value: 20, motor: 5 },
  { label: "Medium", value: 45, motor: 10 },
  { label: "High", value: 70, motor: 15 },
  { label: "Max", value: 85, motor: 18 },
  { label: "Ultra", value: 100, motor: 20 },
];

/**
 * Fallback tokens when Stream Master settings are not loaded yet.
 * Must sit inside your Basic Level ranges (test:Tangent-Club):
 *   1–9 → 5 | 10–49 → 25 | 50–99 → 75 | 100–300 → 150 | 301+ → 350
 */
const LOVENSE_PRESET_TOKENS = {
  lush: {
    Low: { min: 1, max: 9, send: 5 },
    Medium: { min: 10, max: 49, send: 25 },
    High: { min: 50, max: 99, send: 75 },
    Max: { min: 100, max: 300, send: 150 },
    Ultra: { min: 301, max: 9999, send: 350 },
  },
  diamo: {
    Low: { min: 1, max: 9, send: 5 },
    Medium: { min: 10, max: 49, send: 25 },
    High: { min: 50, max: 99, send: 75 },
    Max: { min: 100, max: 300, send: 150 },
    Ultra: { min: 301, max: 9999, send: 350 },
  },
  default: {
    Low: { min: 1, max: 9, send: 5 },
    Medium: { min: 10, max: 49, send: 25 },
    High: { min: 50, max: 99, send: 75 },
    Max: { min: 100, max: 300, send: 150 },
    Ultra: { min: 301, max: 9999, send: 350 },
  },
};

const LOVENSE_SETUP_HINT =
  "Each toy has its own card (Diamo + Lush separately). Direct motor until slider 0 — not Stream Master tip seconds. " +
  "In Stream Master Basic Levels: one toy per row (not Lush,Diamo together). Widget on this tab once.";

const TOY_SPECIAL_COMMANDS = [
  { id: "earthquake", label: "Earthquake", tokens: 100 },
  { id: "fireworks", label: "Fireworks", tokens: 120 },
  { id: "wave", label: "Wave", tokens: 160 },
  { id: "pulse", label: "Pulse", tokens: 200 },
];

let toyControlState = {};
let localToyControlState = {};
const TOY_SLIDER_THROTTLE_MS = 150;
let toyThrottleState = {};
let localToyThrottleState = {};
/** Partner toys — Remote Control UI (bidirectional: either side can share). */
let partnerRemoteToys = [];
/** Skip rebuilding Local Test DOM while user drags a slider (Lovense status events fire often). */
let localToyPanelDragLock = false;
const localToyActivityHint = Object.create(null);

function toyTypeKey(toy) {
  const raw = String(toy?.type || toy?.name || "").toLowerCase();
  if (raw.includes("lush")) return "lush";
  if (raw.includes("diamo")) return "diamo";
  return "default";
}

function findToyRecord(toyId) {
  const id = String(toyId || "");
  const lists = [partnerRemoteToys, getLocalLovenseToys().map((t, i) => normalizeToyForPeer(t, i))];
  for (const list of lists) {
    const hit = list.find((t) => t && String(t.id) === id);
    if (hit) return hit;
  }
  return null;
}

function presetForLevel(levelPercent) {
  const level = Math.max(0, Math.min(100, Number(levelPercent) || 0));
  if (level <= 0) return null;
  const exact = TOY_PRESET_LEVELS.find((p) => p.value === level);
  if (exact) return exact;
  let nearest = TOY_PRESET_LEVELS[0];
  for (const preset of TOY_PRESET_LEVELS) {
    if (Math.abs(preset.value - level) < Math.abs(nearest.value - level)) {
      nearest = preset;
    }
  }
  return nearest;
}

function isDirectMotorMode() {
  return window.DUALPEER_DIRECT_MOTOR !== false;
}

function presetMotorStrength(levelValue) {
  const preset = TOY_PRESET_LEVELS.find((p) => p.value === levelValue);
  if (preset && preset.motor > 0) return preset.motor;
  const bridge = window.dualPeerLovense;
  if (bridge && typeof bridge.strengthForLevel === "function") {
    return bridge.strengthForLevel(levelValue);
  }
  if (bridge && typeof bridge.levelToStrength === "function") {
    return bridge.levelToStrength(levelValue);
  }
  return Math.max(1, Math.min(20, Math.round((Number(levelValue) / 100) * 20)));
}

function presetTokenEntry(toyId, presetLabel) {
  const toy = findToyRecord(toyId);
  const map = LOVENSE_PRESET_TOKENS[toyTypeKey(toy)] || LOVENSE_PRESET_TOKENS.default;
  return map[presetLabel] || LOVENSE_PRESET_TOKENS.default[presetLabel] || { min: 1, max: 9, send: 5 };
}

function presetTokenSend(toyId, presetLabel) {
  const bridge = window.dualPeerLovense;
  if (bridge && typeof bridge.getPresetTokenSend === "function") {
    const synced = bridge.getPresetTokenSend(presetLabel);
    if (synced > 0) return synced;
  }
  return presetTokenEntry(toyId, presetLabel).send;
}

function presetTokenRangeLabel(toyId, presetLabel) {
  const e = presetTokenEntry(toyId, presetLabel);
  return `${e.send} (range ${e.min}–${e.max})`;
}

function resolveTokensForToy(toyId, levelPercent, tokensOverride) {
  if (tokensOverride != null && Number(tokensOverride) > 0) {
    return Math.round(Number(tokensOverride));
  }
  const preset = presetForLevel(levelPercent);
  if (!preset) return 0;
  return presetTokenSend(toyId, preset.label);
}

function percentToTokens(levelPercent) {
  return resolveTokensForToy(null, levelPercent, null);
}

function formatToyDisplayName(toy, idx) {
  const type = String(toy?.type || toy?.toyType || "").trim();
  const nick = String(toy?.nickName || toy?.name || "").trim();
  if (nick && nick.toLowerCase() !== "toy") return nick;
  if (type) {
    if (/lush/i.test(type)) return /lush\s*2|lush2/i.test(type) ? "Lush 2" : "Lush";
    if (/diamo/i.test(type)) return "Diamo";
    return type.charAt(0).toUpperCase() + type.slice(1);
  }
  return `Toy ${idx + 1}`;
}

function normalizeToyForPeer(toy, idx) {
  const lovenseId = toy.id || toy.toyId || toy.deviceId || null;
  let battery = toy.battery ?? toy.batteryLevel ?? toy.power ?? null;
  if (battery != null && battery !== "") {
    battery = String(battery).replace(/%/g, "").trim();
  } else {
    battery = null;
  }
  const displayName = formatToyDisplayName(toy, idx);
  return {
    id: lovenseId ? String(lovenseId) : `toy-${idx + 1}`,
    name: displayName,
    type: toy.type || toy.toyType || displayName,
    status: toy.status || "unknown",
    battery,
  };
}

function getLocalLovenseToys() {
  const toys = window.dualPeerLovense?.toys;
  return Array.isArray(toys) ? toys : [];
}

function broadcastLocalToyInventory() {
  const toys = getLocalLovenseToys();
  if (!toys.length) return false;
  if (!dataConn || !dataConn.open) return false;

  const sent = sendDataChannelMessage({
    type: "toy_inventory",
    toys: toys.map(normalizeToyForPeer),
    ts: Date.now(),
  });
  if (sent) {
    setDataActivityStatus(`Shared ${toys.length} local toy(s) with partner.`, "ok");
  } else {
    setDataActivityStatus("Toy list send failed.", "err");
  }
  return sent;
}

function sendPartnerToyCommand(toyId, levelPercent, tokensOverride) {
  if (!dataConn || !dataConn.open) {
    setDataActivityStatus("No data channel — connect first.", "err");
    return false;
  }

  const level = Math.max(0, Math.min(100, Math.round(Number(levelPercent) || 0)));
  const tipAmount = level <= 0 ? 0 : resolveTokensForToy(toyId, level, tokensOverride);

  const payload = {
    type: "toy",
    toyId: toyId || "default-toy",
    level,
    tipAmount,
    tipperName: sessionRole === "host" ? "Host" : sessionRole === "guest" ? "Guest" : "You",
    ts: Date.now(),
  };
  const sent = sendDataChannelMessage(payload);
  if (!sent) {
    setDataActivityStatus("Send failed — data channel not open.", "err");
    return false;
  }
  if (level <= 0) {
    setDataActivityStatus(`Stop sent — partner toy until slider 0 ends (${toyId}).`, "ok");
    updateToyActivityDisplay(toyId, "remote", "Stop sent to partner");
  } else {
    const label = presetLabelForLevel(level);
    const motor = presetMotorStrength(level);
    setDataActivityStatus(
      `Sent ${label || level + "%"} (motor ${motor}/20) to partner — holds until they set slider 0.`,
      "ok"
    );
    updateToyActivityDisplay(
      toyId,
      "remote",
      isDirectMotorMode()
        ? `${label || level + "%"} · motor ${motor}/20 — waiting for partner`
        : `${label || level + "%"} · ${tipAmount} tokens — waiting for partner`
    );
  }
  return true;
}

function getToyThrottleState(toyId, store) {
  const id = toyId || "default-toy";
  if (!store[id]) {
    store[id] = { lastSentAt: 0, trailingTimer: null, pending: null };
  }
  return store[id];
}

function clearToyThrottleState(toyId, store) {
  const state = store[toyId];
  if (!state) return;
  if (state.trailingTimer) {
    clearTimeout(state.trailingTimer);
    state.trailingTimer = null;
  }
  state.pending = null;
}

function clearAllToyPendingSends(store) {
  Object.keys(store).forEach((toyId) => clearToyThrottleState(toyId, store));
}

function scheduleThrottledToyAction(levelPercent, toyId, tokensOverride, store, runFn) {
  const safeToyId = toyId || "default-toy";
  const level = Math.max(0, Math.min(100, Number(levelPercent) || 0));

  if (level === 0) {
    clearToyThrottleState(safeToyId, store);
    runFn(0, 0);
    return;
  }

  const state = getToyThrottleState(safeToyId, store);
  const now = Date.now();
  const elapsed = now - state.lastSentAt;

  if (elapsed >= TOY_SLIDER_THROTTLE_MS) {
    state.lastSentAt = now;
    runFn(level, tokensOverride);
    return;
  }

  state.pending = { level, tokens: tokensOverride };
  if (state.trailingTimer) return;

  const waitMs = TOY_SLIDER_THROTTLE_MS - elapsed;
  state.trailingTimer = setTimeout(() => {
    state.trailingTimer = null;
    if (!state.pending) return;
    const pending = state.pending;
    state.pending = null;
    state.lastSentAt = Date.now();
    runFn(pending.level, pending.tokens);
  }, waitMs);
}

function applyToyIntensity(toyId, levelPercent, options) {
  const opts = options || {};
  const throttle = !!opts.throttle;
  const tokensOverride = opts.tokens != null ? opts.tokens : null;
  const safeToyId = toyId || "default-toy";
  const level = Math.max(0, Math.min(100, Math.round(Number(levelPercent) || 0)));

  toyControlState[safeToyId] = toyControlState[safeToyId] || { level: 0, specials: {} };
  toyControlState[safeToyId].level = level;

  const slider = els.toyControlList?.querySelector(
    `.toy-slider[data-scope="remote"][data-toy-id="${safeToyId}"]`
  );
  if (slider instanceof HTMLInputElement) slider.value = String(level);
  updateToyPresetActive(safeToyId, level, "remote");

  if (level === 0) {
    clearToyThrottleState(safeToyId, toyThrottleState);
    sendPartnerToyCommand(safeToyId, 0, 0);
    updateToyActivityDisplay(safeToyId, "remote");
    return;
  }

  if (throttle) {
    schedulePartnerToyCommand(level, safeToyId, tokensOverride);
    return;
  }

  clearToyThrottleState(safeToyId, toyThrottleState);
  sendPartnerToyCommand(safeToyId, level, tokensOverride);
  updateToyActivityDisplay(safeToyId, "remote");
}

function applyLocalToyIntensity(toyId, levelPercent, options) {
  const opts = options || {};
  const throttle = !!opts.throttle;
  const tokensOverride = opts.tokens != null ? opts.tokens : null;
  const safeToyId = toyId || "default-toy";
  const level = Math.max(0, Math.min(100, Math.round(Number(levelPercent) || 0)));

  localToyControlState[safeToyId] = localToyControlState[safeToyId] || { level: 0, specials: {} };
  localToyControlState[safeToyId].level = level;

  const slider = els.localToyTestList?.querySelector(
    `.toy-slider[data-scope="local"][data-toy-id="${safeToyId}"]`
  );
  if (slider instanceof HTMLInputElement) slider.value = String(level);
  updateToyPresetActive(safeToyId, level, "local");

  syncLovenseFromBridge();
  const bridge = window.dualPeerLovense;

  if (level === 0) {
    clearToyThrottleState(safeToyId, localToyThrottleState);
    clearToySpecialsForToy(safeToyId, "local");
    if (bridge && typeof bridge.stopToy === "function") {
      bridge.stopToy(safeToyId);
    } else {
      stopLocalLovenseToys(safeToyId);
    }
    updateToyActivityDisplay(safeToyId, "local", "Stopped");
    return;
  }

  const run = () => {
    if (level > 0) clearToySpecialsForToy(safeToyId, "local");
    const tokens = isDirectMotorMode()
      ? 0
      : resolveTokensForToy(safeToyId, level, tokensOverride);
    const motor = presetMotorStrength(level);
    setLocalToyActivityHint(
      safeToyId,
      isDirectMotorMode()
        ? `Sending motor ${motor}/20…`
        : `Sending ${tokens} tokens…`
    );
    applyLovenseControl({
      toyId: safeToyId,
      level,
      tipAmount: tokens,
      tipperName: "Local-Test",
    })
      .then((result) => {
        setLocalToyActivityHint(safeToyId, formatActivityFromResult(result, level));
      })
      .catch((err) => {
        setLocalToyActivityHint(
          safeToyId,
          `Error: ${err?.message || "Lovense command failed"}`
        );
      });
  };

  if (throttle) {
    scheduleThrottledToyAction(level, safeToyId, tokensOverride, localToyThrottleState, (lvl, tok) => {
      if (lvl > 0) clearToySpecialsForToy(safeToyId, "local");
      const tokens = isDirectMotorMode() ? 0 : resolveTokensForToy(safeToyId, lvl, tok);
      applyLovenseControl({
        toyId: safeToyId,
        level: lvl,
        tipAmount: tokens,
        tipperName: "Local-Test",
      })
        .then((result) => {
          setLocalToyActivityHint(
            safeToyId,
            formatActivityFromResult(result || { ok: false, hint: "Lovense command failed" }, lvl)
          );
        })
        .catch((err) => {
          setLocalToyActivityHint(safeToyId, `Error: ${err?.message || "failed"}`);
        });
    });
    return;
  }

  clearToyThrottleState(safeToyId, localToyThrottleState);
  run();
}

function schedulePartnerToyCommand(levelPercent, toyId, tokensOverride) {
  scheduleThrottledToyAction(levelPercent, toyId, tokensOverride, toyThrottleState, (level, tokens) => {
    sendPartnerToyCommand(toyId, level, tokens);
  });
}

function updateToyPresetActive(toyId, level, scope) {
  const root = scope === "local" ? els.localToyTestList : els.toyControlList;
  if (!root || !toyId) return;
  const numericLevel = Math.max(0, Math.min(100, Number(level) || 0));
  const activeLevel =
    numericLevel > 0 && TOY_PRESET_LEVELS.some((p) => Number(p.value) === numericLevel)
      ? numericLevel
      : null;
  const buttons = root.querySelectorAll(
    `.toy-preset-btn[data-scope="${scope}"][data-toy-id="${toyId}"]`
  );
  buttons.forEach((btn) => {
    const btnLevel = Number(btn.getAttribute("data-level") || 0);
    btn.classList.toggle("active", activeLevel !== null && btnLevel === activeLevel);
  });
}

function formatToyStatusBadge(toy) {
  const name = (toy.name || toy.type || "Toy").trim();
  const on = toy.status === "on" || toy.status === 1 || toy.status === "1";
  const rawBat = toy.battery;
  const battery =
    rawBat != null && rawBat !== "" && !Number.isNaN(Number(rawBat)) ? `${Math.round(Number(rawBat))}%` : null;
  return { name, on, battery };
}

function presetLabelForLevel(level) {
  const lv = Number(level) || 0;
  const hit = TOY_PRESET_LEVELS.find((p) => p.value === lv);
  return hit ? hit.label : lv > 0 ? `${lv}%` : "";
}

function formatActivityFromResult(result, level) {
  if (!result) return "Command failed — extension not ready";
  if (!result.ok) {
    if (result.hint) return result.hint;
    if (result.method === "motor-failed" || result.method === "receiveTip-failed") {
      return "Tip failed — open Lovense widget, set Stream Master levels (vLevel > 0), one toy per row";
    }
    return "Command failed — check extension and Stream Master";
  }
  if (result.hint) return result.hint;
  if (result.method === "receiveTip-hold" || result.method === "tipMessage-hold") {
    return result.hint || `${result.tokens} tokens (hold)`;
  }
  if (result.method === "tipMessage") {
    return `${result.tokens} tokens · per-toy tip`;
  }
  if (result.method === "sendCommand") {
    return result.hint || `Motor ${result.strength || "?"}/20 (direct)`;
  }
  if (result.method === "preset-direct" || result.method === "special-tip-hold") {
    return result.hint || `Pattern ${result.special} — uncheck to stop`;
  }
  if (result.method === "special") {
    return `Pattern ${result.special} · ${result.tokens} tokens`;
  }
  if (result.method && String(result.method).startsWith("special-off")) {
    const label = presetLabelForLevel(level);
    return result.hint || (label ? `Back to ${label}` : "Pattern off");
  }
  return "Active";
}

function clearToySpecialsForToy(toyId, scope, options) {
  const opts = options || {};
  const stateMap = scope === "local" ? localToyControlState : toyControlState;
  const st = stateMap[toyId];
  if (!st?.specials) return;

  const root = getToyPanelRoot(scope);
  TOY_SPECIAL_COMMANDS.forEach((c) => {
    if (!st.specials[c.id]) return;
    if (!opts.uiOnly) {
      if (scope === "local") {
        applyToySpecialLocal(toyId, c.id, false, scope);
      } else {
        sendToySpecialPayload(toyId, c.id, false);
      }
    }
    st.specials[c.id] = false;
    if (!root) return;
    const cb = root.querySelector(
      `input[data-special="${c.id}"][data-scope="${scope}"][data-toy-id="${toyId}"]`
    );
    if (cb instanceof HTMLInputElement) cb.checked = false;
  });
}

function describeToyActivity(toyId, scope) {
  const stateMap = scope === "local" ? localToyControlState : toyControlState;
  const st = stateMap[toyId] || { level: 0, specials: {} };
  const parts = [];

  if (st.level > 0) {
    const label = presetLabelForLevel(st.level);
    if (isDirectMotorMode()) {
      const motor = presetMotorStrength(st.level);
      parts.push(`${label || st.level + "%"} · motor ${motor}/20 (direct)`);
    } else {
      const tokens = resolveTokensForToy(toyId, st.level, null);
      parts.push(`${label} · ${tokens} tokens`);
    }
  }

  const activeSpecials = TOY_SPECIAL_COMMANDS.filter((c) => st.specials[c.id]).map((c) => c.label);
  if (activeSpecials.length) {
    parts.push(`Pattern: ${activeSpecials.join(", ")}`);
  }

  if (!parts.length) return "Idle — tap a level or move the slider";
  return parts.join(" · ");
}

function getToyPanelRoot(scope) {
  return scope === "local" ? els.localToyTestList : els.toyControlList;
}

function updateToyActivityDisplay(toyId, scope, hint) {
  const root = getToyPanelRoot(scope);
  if (!root || !toyId) return;
  const block = root.querySelector(`.toy-block[data-scope="${scope}"][data-toy-id="${toyId}"]`);
  if (!block) return;

  const stateMap = scope === "local" ? localToyControlState : toyControlState;
  const st = stateMap[toyId] || { level: 0, specials: {} };
  const isActive = st.level > 0 || TOY_SPECIAL_COMMANDS.some((c) => st.specials[c.id]);

  block.classList.toggle("is-active", isActive);

  const chip = block.querySelector(".toy-status-chip");
  if (chip) {
    chip.classList.toggle("is-on", isActive);
    chip.textContent = isActive ? "Active" : "Ready";
  }

  const activity = block.querySelector(".toy-activity-line");
  if (activity) {
    const cached = scope === "local" ? localToyActivityHint[toyId] : "";
    activity.textContent = hint || cached || describeToyActivity(toyId, scope);
  }
}

function setLocalToyActivityHint(toyId, text) {
  if (!toyId) return;
  if (text) localToyActivityHint[toyId] = text;
  else delete localToyActivityHint[toyId];
  updateToyActivityDisplay(toyId, "local", text || undefined);
}

function getToyControlContext(toyId, scope) {
  const stateMap = scope === "local" ? localToyControlState : toyControlState;
  const st = stateMap[toyId] || { level: 0 };
  const level = Math.max(0, Math.min(100, Number(st.level) || 0));
  const tipAmount = level > 0 ? resolveTokensForToy(toyId, level, null) : 0;
  const tipperName =
    scope === "local"
      ? "Local-Test"
      : sessionRole === "host"
        ? "Host"
        : sessionRole === "guest"
          ? "Guest"
          : "You";
  return { level, tipAmount, tipperName };
}

function applyToySpecialLocal(toyId, special, enabled, scope) {
  const ctx = getToyControlContext(toyId, scope);
  const tipAmount = enabled
    ? resolveSpecialTipAmount(toyId, special, ctx.level, ctx.tipAmount)
    : ctx.tipAmount;
  applyLovenseSpecial({
    toyId,
    special,
    enabled,
    level: ctx.level,
    tipAmount,
    tipperName: ctx.tipperName,
  }).then((result) => {
    const ok = result && result.ok;
    const ctxAfter = getToyControlContext(toyId, scope);
    const statusMsg = ok
      ? result.hint ||
        (enabled
          ? `Special ${special} on (${result.tokens || "?"} tokens).`
          : `Special ${special} off — base level restored.`)
      : result?.hint ||
        `Special ${special} failed — enable in Stream Master (unique token, no overlap with Basic Levels).`;
    setDataActivityStatus(statusMsg, ok ? "ok" : "err");
    updateToyActivityDisplay(
      toyId,
      scope,
      ok
        ? formatActivityFromResult(result, ctxAfter.level)
        : result?.hint || `Special ${special} failed`
    );
  });
}

function resolveSpecialTipAmount(toyId, special, level, tipAmount) {
  let tokens = Math.round(Number(tipAmount) || 0);
  if (tokens < 1) {
    const cmd = TOY_SPECIAL_COMMANDS.find((c) => c.id === special);
    if (cmd?.tokens) tokens = cmd.tokens;
    else if (level > 0) tokens = resolveTokensForToy(toyId, level, null);
  }
  return tokens;
}

function sendToySpecialPayload(toyId, special, checked) {
  if (!dataConn || !dataConn.open) {
    setDataActivityStatus("No data channel — connect first.", "err");
    return;
  }
  const ctx = getToyControlContext(toyId, "remote");
  const tipAmount = checked
    ? resolveSpecialTipAmount(toyId, special, ctx.level, ctx.tipAmount)
    : ctx.tipAmount;
  const sent = sendDataChannelMessage({
    type: "toy_special",
    toyId,
    special,
    enabled: !!checked,
    level: ctx.level,
    tipAmount,
    tipperName: ctx.tipperName,
    ts: Date.now(),
  });
  if (sent) {
    setDataActivityStatus(
      checked
        ? `${special} on sent to partner (${tipAmount} tokens) — uncheck to stop.`
        : `${special} off sent — partner restores base level if set.`,
      "ok"
    );
    updateToyActivityDisplay(
      toyId,
      "remote",
      checked ? `Pattern ${special} sent — waiting for partner` : `Pattern ${special} stop sent`
    );
  } else {
    setDataActivityStatus("Send failed — data channel not open.", "err");
  }
}

function buildToyControlBlock(toy, idx, scope, stateMap) {
  const toyId = toy.id || `toy-${idx + 1}`;
  const badge = formatToyStatusBadge(toy);
  const typeKey = toyTypeKey(toy);
  const tokenMap = LOVENSE_PRESET_TOKENS[typeKey] || LOVENSE_PRESET_TOKENS.default;

  if (!stateMap[toyId]) {
    stateMap[toyId] = { level: 0, specials: {} };
  }

  const block = document.createElement("section");
  block.className = "toy-block";
  block.dataset.toyId = toyId;
  block.dataset.scope = scope;

  const head = document.createElement("div");
  head.className = "toy-block-head";
  const title = document.createElement("h3");
  title.className = "toy-block-title";
  title.textContent = badge.name;
  head.appendChild(title);

  const statusRow = document.createElement("div");
  statusRow.className = "toy-status-row";

  const chip = document.createElement("span");
  chip.className = "toy-status-chip" + (badge.on ? " is-connected" : "");
  chip.textContent = badge.on ? "Ready" : "Off";
  statusRow.appendChild(chip);

  if (badge.battery) {
    const bat = document.createElement("span");
    bat.className = "toy-battery";
    bat.textContent = `Battery ${badge.battery}`;
    bat.title = "Battery level from Lovense extension";
    statusRow.appendChild(bat);
  }

  head.appendChild(statusRow);

  const activity = document.createElement("p");
  activity.className = "toy-activity-line";
  activity.setAttribute("aria-live", "polite");
  activity.textContent = describeToyActivity(toyId, scope);
  head.appendChild(activity);

  block.appendChild(head);

  const btnRow = document.createElement("div");
  btnRow.className = "toy-preset-row";
  TOY_PRESET_LEVELS.forEach((preset) => {
    const entry = tokenMap[preset.label] || LOVENSE_PRESET_TOKENS.default[preset.label];
    const tokens = presetTokenSend(toyId, preset.label) || entry?.send || 5;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toy-preset-btn";
    b.textContent = preset.label;
    b.dataset.scope = scope;
    b.dataset.toyId = toyId;
    b.dataset.level = String(preset.value);
    b.dataset.tokens = String(tokens);
    const motor = presetMotorStrength(preset.value);
    b.title = isDirectMotorMode()
      ? `Motor ${motor}/20 · holds until slider 0`
      : entry
        ? `${tokens} tokens · Stream Master range ${entry.min}–${entry.max}`
        : `${tokens} tokens`;
    if ((stateMap[toyId].level || 0) > 0 && Number(preset.value) === Number(stateMap[toyId].level)) {
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
  slider.value = String(Math.min(100, stateMap[toyId].level || 0));
  slider.dataset.scope = scope;
  slider.dataset.toyId = toyId;
  slider.className = "toy-slider";
  slider.setAttribute("aria-label", `Intensity ${badge.name}`);
  sliderWrap.appendChild(slider);
  block.appendChild(sliderWrap);

  const specialWrap = document.createElement("div");
  specialWrap.className = "toy-special-row";
  TOY_SPECIAL_COMMANDS.forEach((cmd) => {
    const id = `special-${scope}-${toyId}-${cmd.id}`;
    const item = document.createElement("label");
    item.className = "toy-special-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = id;
    cb.dataset.scope = scope;
    cb.dataset.toyId = toyId;
    cb.dataset.special = cmd.id;
    cb.checked = !!stateMap[toyId].specials[cmd.id];
    const span = document.createElement("span");
    span.textContent = cmd.label;
    cb.title = `Checkbox on/off — ${cmd.tokens || "?"} tokens in Stream Master`;
    item.appendChild(cb);
    item.appendChild(span);
    specialWrap.appendChild(item);
  });
  block.appendChild(specialWrap);

  return block;
}

function renderToyControls(toys) {
  if (!els.toyControlList) return;
  const list = els.toyControlList;
  list.innerHTML = "";

  const toyList = Array.isArray(toys) ? toys : partnerRemoteToys;
  if (!toyList.length) {
    list.innerHTML =
      '<div class="toy-empty-note">Waiting for partner toys — connect via PeerJS (host and guest both share their lists).</div>';
    return;
  }

  toyList.forEach((toy, idx) => {
    list.appendChild(buildToyControlBlock(toy, idx, "remote", toyControlState));
  });
}

function localToyPanelSignature(toys) {
  return toys
    .map((t, i) => {
      const n = normalizeToyForPeer(t, i);
      return `${n.id}:${n.status}:${n.battery ?? ""}`;
    })
    .join("|");
}

function patchLocalToyBlockMeta(toy, idx) {
  const toyId = toy.id || `toy-${idx + 1}`;
  const root = els.localToyTestList;
  if (!root) return;
  const block = root.querySelector(`.toy-block[data-scope="local"][data-toy-id="${toyId}"]`);
  if (!block) return;
  const badge = formatToyStatusBadge(toy);
  const chip = block.querySelector(".toy-status-chip");
  if (chip) {
    chip.classList.toggle("is-connected", badge.on);
    chip.textContent = badge.on ? "Ready" : "Off";
  }
  const bat = block.querySelector(".toy-battery");
  if (bat) {
    if (badge.battery) {
      bat.textContent = `Battery ${badge.battery}`;
      bat.hidden = false;
    } else {
      bat.hidden = true;
    }
  }
}

function renderLocalToyTestPanel({ force = false } = {}) {
  if (!els.localToyTestList) return;
  if (localToyPanelDragLock && !force) return;

  const list = els.localToyTestList;

  if (!isLovenseReady()) {
    const hint = lovenseNotReadyMessage();
    list.innerHTML = `<div class="toy-empty-note">${hint}</div>`;
    list.dataset.toyPanelSig = "";
    return;
  }

  const toys = getLocalLovenseToys().map((t, i) => normalizeToyForPeer(t, i));
  if (!toys.length) {
    list.innerHTML = '<div class="toy-empty-note">No toys connected in the extension.</div>';
    list.dataset.toyPanelSig = "";
    return;
  }

  const sig = localToyPanelSignature(toys);
  const prevSig = list.dataset.toyPanelSig || "";
  const hasBlocks = list.querySelector(".toy-block");

  if (!force && hasBlocks && prevSig === sig) {
    toys.forEach((toy, idx) => patchLocalToyBlockMeta(toy, idx));
    return;
  }

  list.dataset.toyPanelSig = sig;
  list.innerHTML = "";
  toys.forEach((toy, idx) => {
    list.appendChild(buildToyControlBlock(toy, idx, "local", localToyControlState));
  });
  toys.forEach((t) => updateToyActivityDisplay(t.id, "local", localToyActivityHint[t.id]));
}

function updateLovenseSetupHint() {
  if (els.lovenseSetupHint) els.lovenseSetupHint.textContent = LOVENSE_SETUP_HINT;
}

function handleToyPanelClick(e, scope) {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  if (!target.classList.contains("toy-preset-btn")) return;
  if (target.dataset.scope !== scope) return;
  const toyId = target.dataset.toyId;
  const presetLevel = Math.min(100, Number(target.dataset.level || 0));
  const presetTokens = Math.max(0, Number(target.dataset.tokens || 0));
  if (!toyId) return;

  const isStop = target.classList.contains("active");
  const level = isStop ? 0 : presetLevel;
  if (!isStop && level > 0) clearToySpecialsForToy(toyId, scope);
  if (scope === "local") {
    applyLocalToyIntensity(toyId, level, { throttle: false, tokens: isStop ? 0 : presetTokens });
  } else {
    applyToyIntensity(toyId, level, { throttle: false, tokens: isStop ? 0 : presetTokens });
  }
}

function handleToyPanelInput(e, scope) {
  const target = e.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (!target.classList.contains("toy-slider")) return;
  if (target.dataset.scope !== scope) return;
  const toyId = target.dataset.toyId;
  if (!toyId) return;
  const level = Math.max(0, Math.min(100, Number(target.value) || 0));
  if (scope === "local") {
    applyLocalToyIntensity(toyId, level, { throttle: level > 0 });
  } else {
    applyToyIntensity(toyId, level, { throttle: level > 0 });
  }
}

function handleToyPanelSpecialChange(e, scope) {
  const target = e.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.type !== "checkbox" || !target.dataset.special) return;
  if (target.dataset.scope !== scope) return;
  const toyId = target.dataset.toyId;
  const special = target.dataset.special;
  if (!toyId || !special) return;

  const stateMap = scope === "local" ? localToyControlState : toyControlState;
  stateMap[toyId] = stateMap[toyId] || { level: 0, specials: {} };

  if (target.checked) {
    TOY_SPECIAL_COMMANDS.forEach((c) => {
      if (c.id === special || !stateMap[toyId].specials[c.id]) return;
      stateMap[toyId].specials[c.id] = false;
      const root = getToyPanelRoot(scope);
      const cb = root?.querySelector(
        `input[data-special="${c.id}"][data-scope="${scope}"][data-toy-id="${toyId}"]`
      );
      if (cb instanceof HTMLInputElement) cb.checked = false;
      if (scope === "local") {
        applyToySpecialLocal(toyId, c.id, false, scope);
      } else {
        sendToySpecialPayload(toyId, c.id, false);
      }
    });
  }

  stateMap[toyId].specials[special] = target.checked;
  updateToyActivityDisplay(toyId, scope);

  if (scope === "local") {
    applyToySpecialLocal(toyId, special, target.checked, "local");
    return;
  }
  sendToySpecialPayload(toyId, special, target.checked);
}

function initDynamicToyControls() {
  if (!els.toyControlList) return;
  renderToyControls(partnerRemoteToys);

  els.toyControlList.addEventListener("click", (e) => handleToyPanelClick(e, "remote"));
  els.toyControlList.addEventListener("input", (e) => handleToyPanelInput(e, "remote"));
  els.toyControlList.addEventListener("change", (e) => handleToyPanelSpecialChange(e, "remote"));
}

function initLocalToyTestPanel() {
  if (!els.localToyTestList) return;
  updateLovenseSetupHint();
  renderLocalToyTestPanel({ force: true });

  const list = els.localToyTestList;
  list.addEventListener("pointerdown", (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.classList.contains("toy-slider")) {
      localToyPanelDragLock = true;
    }
  });
  const endDrag = () => {
    if (!localToyPanelDragLock) return;
    localToyPanelDragLock = false;
    renderLocalToyTestPanel();
  };
  list.addEventListener("pointerup", endDrag);
  list.addEventListener("pointercancel", endDrag);
  list.addEventListener("lostpointercapture", endDrag);

  list.addEventListener("click", (e) => handleToyPanelClick(e, "local"));
  list.addEventListener("input", (e) => handleToyPanelInput(e, "local"));
  list.addEventListener("change", (e) => handleToyPanelSpecialChange(e, "local"));
}

function formatChatTime(ts) {
  const d = new Date(ts || Date.now());
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function appendChatMessage(sender, text, isLocal, ts, { variant } = {}) {
  if (!els.chatMessages) {
    setDataActivityStatus("Chat container not found (#chat-messages).", "err");
    return;
  }
  const msg = document.createElement("div");
  let className = "chat-message" + (isLocal ? " local" : " remote");
  if (variant === "technique") className += " chat-message--technique";
  msg.className = className;
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

function appendChatTechniqueMessage(sender, label, isLocal, ts) {
  const text = isLocal ? `You request: ${label}` : `${sender} requests: ${label}`;
  appendChatMessage(isLocal ? "You" : sender, text, isLocal, ts, { variant: "technique" });
}

let techniqueBellCtx = null;
function playTechniqueBell() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!techniqueBellCtx) techniqueBellCtx = new Ctx();
    const ctx = techniqueBellCtx;
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(840, now);
    osc.frequency.exponentialRampToValueAtTime(660, now + 0.2);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.028, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.24);
  } catch (_) {
    /* ignore audio errors */
  }
}

function getChatDisplayName() {
  if (global.MemberProfile?.getChatSenderName) return MemberProfile.getChatSenderName();
  return sessionRole === "host" ? "You" : sessionRole === "guest" ? "Partner" : "You";
}

function shareMemberProfileOverDataChannel() {
  if (!global.MemberProfile?.shareProfileOverDataChannel) return;
  MemberProfile.shareProfileOverDataChannel((payload) => sendDataChannelMessage(payload));
}

function isLiveSessionActive() {
  return !!(sessionRole && (dataConn?.open || hasRemoteVideo()));
}

function syncStreamTabStatus() {
  const hostEl = document.getElementById("streamStatusHost");
  const guestEl = document.getElementById("streamStatusGuest");
  const dataEl = document.getElementById("streamStatusData");
  if (hostEl && els.statusHost) hostEl.textContent = els.statusHost.textContent;
  if (guestEl && els.statusGuest) guestEl.textContent = els.statusGuest.textContent;
  if (dataEl && els.statusData) dataEl.textContent = els.statusData.textContent;
  if (global.MemberProfile?.maybeAutoStreamTab) {
    MemberProfile.maybeAutoStreamTab(isLiveSessionActive());
  }
  if (global.MemberProfile?.refreshAccountMini) MemberProfile.refreshAccountMini();
}

function handleIncomingChatPayload(data) {
  if (!data || typeof data !== "object" || data.type !== "chat") return;
  const text = String(data.text || "").trim();
  if (!text) return;
  const sender = String(data.sender || "Partner");
  if (global.DualPeerSocial?.appendLocalEcho) {
    global.DualPeerSocial.appendLocalEcho(text, sender);
  } else {
    appendChatMessage(sender, text, false, data.ts);
  }
}

function normalizeDataPayload(raw) {
  if (raw == null) return null;

  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return { type: "chat", text: raw };
    }
  }

  if (raw instanceof ArrayBuffer) {
    try {
      return JSON.parse(new TextDecoder().decode(raw));
    } catch (_) {
      return null;
    }
  }

  if (ArrayBuffer.isView(raw)) {
    try {
      return JSON.parse(new TextDecoder().decode(raw.buffer, raw.byteOffset, raw.byteLength));
    } catch (_) {
      return null;
    }
  }

  if (typeof raw === "object") {
    if (raw.type) return raw;
    if (raw.data && typeof raw.data === "object" && raw.data.type) return raw.data;
  }

  return null;
}

function sendDataChannelMessage(payload) {
  if (!dataConn || !dataConn.open) return false;
  try {
    dataConn.send(payload);
    return true;
  } catch (e) {
    try {
      dataConn.send(JSON.stringify(payload));
      return true;
    } catch (e2) {
      console.error("Data channel send failed:", e2);
      return false;
    }
  }
}

function handleIncomingDataMessage(raw) {
  const data = normalizeDataPayload(raw);
  if (!data || !data.type) return;
  if (data.type === "toy_inventory_request") {
    broadcastLocalToyInventory();
    return;
  }
  if (data.type === "toy_inventory") {
    handleIncomingToyInventory(data);
    return;
  }
  if (data.type === "toy_ack") {
    const methodNote = data.method ? ` (${data.method})` : "";
    setDataActivityStatus(
      data.ok ? `Partner applied your command${methodNote}.` : "Partner could not apply the command.",
      data.ok ? "ok" : "err"
    );
    if (data.toyId) {
      const hint = data.ok
        ? data.method === "sendCommand"
          ? "Partner: motor active (until they set slider 0)"
          : data.hint || `Partner applied${methodNote}`
        : "Partner: command failed";
      updateToyActivityDisplay(String(data.toyId), "remote", hint);
    }
    return;
  }
  if (data.type === "toy_special_ack") {
    setDataActivityStatus(
      data.ok
        ? data.hint || `Partner: ${data.special} ${data.enabled ? "on" : "off"}.`
        : data.hint || `Partner could not apply ${data.special}.`,
      data.ok ? "ok" : "err"
    );
    if (data.toyId) {
      updateToyActivityDisplay(
        String(data.toyId),
        "remote",
        data.ok ? data.hint || `Partner: ${data.special} ${data.enabled ? "on" : "off"}` : `Partner: ${data.special} failed`
      );
    }
    return;
  }
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
  if (data.type === "session_end") {
    endSessionChat();
    return;
  }
  if (data.type === "host_peer_id") {
    const peerId = String(data.peerId || "").trim();
    if (peerId) global.DualPeerSocial?.applyHostPeerIdFromMeetings?.(peerId);
    return;
  }
  if (data.type === "profile" || data.type === "profile_request") {
    if (data.type === "profile_request") {
      shareMemberProfileOverDataChannel();
      return;
    }
    if (global.MemberProfile?.handleIncomingProfile) MemberProfile.handleIncomingProfile(data);
    return;
  }
  if (data.type === "technique_request") {
    if (global.MemberProfile?.handleIncomingTechniqueRequest) {
      MemberProfile.handleIncomingTechniqueRequest(data);
    }
    return;
  }
  setDataActivityStatus("Unknown data message received.", "err");
}

async function publishHostPeerIdToGuest(peerId) {
  if (!peerId || !global.DualPeerSocial?.publishHostPeerId) return;
  try {
    const meetingId = await global.DualPeerSocial.resolveLiveMeetingId?.();
    if (!meetingId) {
      setStatus(
        els.statusHost,
        "First create an instant session (Setup → New session), then Start Camera.",
        "err"
      );
      return;
    }
    await global.DualPeerSocial.publishHostPeerId(meetingId, peerId);
    setStatus(els.statusHost, `Session ID shared with partner: ${peerId}`, "ok");
    if (dataConn?.open) {
      sendDataChannelMessage({ type: "host_peer_id", peerId });
    }
  } catch (err) {
    setStatus(els.statusHost, err.message || "Could not share Peer ID.", "err");
    console.warn("[social] publish peer id failed:", err);
  }
}

global.appSessionRole = () => sessionRole;

function relayChatToPeer(text, sender) {
  const payload = {
    type: "chat",
    text,
    sender: sender || getChatDisplayName(),
    ts: Date.now(),
  };
  try {
    sendDataChannelMessage(payload);
    setDataActivityStatus("Chat message sent.", "ok");
  } catch (e) {
    setDataActivityStatus("Chat send failed: " + (e && e.message ? e.message : String(e)), "err");
  }
}

global.DualPeerChat = {
  relayToPeer: (text) => relayChatToPeer(text, getChatDisplayName()),
  ensureEmojiBars: ensureChatEmojiBars,
};

function sendChatMessage() {
  if (!els.chatInput || !els.chatMessages) {
    setDataActivityStatus("Chat UI not ready (#chat-input / #chat-messages).", "err");
    return;
  }
  const text = (els.chatInput.value || "").trim();
  if (!text) return;

  const sender = getChatDisplayName();
  const ts = Date.now();

  if (global.DualPeerSocial?.sendPersistentMessage) {
    global.DualPeerSocial.sendPersistentMessage(text).catch((err) => {
      setDataActivityStatus(err?.message || "Chat could not be saved.", "err");
      global.DualPeerSocial?.appendLocalEcho?.(text, sender);
    });
  } else {
    appendChatMessage("You", text, true, ts);
  }

  els.chatInput.value = "";
  els.chatInput.focus();

  if (dataConn?.open) {
    relayChatToPeer(text, sender);
  } else {
    setDataActivityStatus("Saved to your contact chat — connect live to reach partner instantly.", "ok");
  }
}

const CHAT_EMOJIS = [
  "😉",
  "😘",
  "😍",
  "🥵",
  "💋",
  "🔥",
  "🍑",
  "🍆",
  "👅",
  "💦",
  "🖤",
  "❤️",
  "⛓️",
  "😈",
];

function insertEmojiIntoInput(input, emoji) {
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return;
  const value = input.value || "";
  const start = Number.isInteger(input.selectionStart) ? input.selectionStart : value.length;
  const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : value.length;
  const prefix = value.slice(0, start);
  const suffix = value.slice(end);
  input.value = `${prefix}${emoji}${suffix}`;
  const cursor = prefix.length + emoji.length;
  input.setSelectionRange(cursor, cursor);
  input.focus();
}

function insertEmojiIntoChatInput(emoji) {
  insertEmojiIntoInput(els.chatInput, emoji);
}

function mountChatEmojiBar({ anchor, barId, getInput, placement = "before" }) {
  if (!anchor || !barId || typeof getInput !== "function") return;
  if (document.getElementById(barId)) return;
  const bar = document.createElement("div");
  bar.id = barId;
  bar.className = "chat-emoji-bar";
  CHAT_EMOJIS.forEach((emoji) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-emoji-btn";
    btn.textContent = emoji;
    btn.dataset.emoji = emoji;
    btn.title = `Insert ${emoji}`;
    bar.appendChild(btn);
  });
  bar.addEventListener("click", (e) => {
    const btn = e.target?.closest?.(".chat-emoji-btn");
    if (!btn) return;
    insertEmojiIntoInput(getInput(), btn.dataset.emoji || btn.textContent || "");
  });
  if (placement === "inside") {
    anchor.appendChild(bar);
  } else {
    anchor.insertAdjacentElement("beforebegin", bar);
  }
}

function ensureChatEmojiBars() {
  mountChatEmojiBar({
    anchor: document.getElementById("chat-input-row"),
    barId: "chatEmojiBar",
    getInput: () => els.chatInput,
  });
  mountChatEmojiBar({
    anchor: document.getElementById("headerChatEmojiMount"),
    barId: "headerChatEmojiBar",
    getInput: () => document.getElementById("headerChatInput"),
    placement: "inside",
  });
}

function initChatControls() {
  ensureChatEmojiBars();
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
  syncLovenseFromBridge();
  const bridge = window.dualPeerLovense;
  return !!(bridge?.ready && bridge?.instance);
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
    .map((t) => {
      const n = normalizeToyForPeer(t, 0);
      const bat = n.battery ? ` · ${n.battery}%` : "";
      return `${n.type || "toy"}: ${n.status === "on" ? "on" : "off"}${bat}`;
    })
    .join(" · ");
}

function formatLovenseMotorStatus(detail) {
  const direct =
    (detail && detail.directMotor) ||
    isDirectMotorMode();
  if (direct) {
    return "Motor: direct — vibrates until slider 0 (Stream Master reaction times ignored for levels).";
  }
  const warnings =
    (detail && detail.streamWarnings) ||
    (window.dualPeerLovense &&
      typeof window.dualPeerLovense.getStreamMasterWarnings === "function" &&
      window.dualPeerLovense.getStreamMasterWarnings()) ||
    [];
  const warn = warnings.length ? ` ⚠ ${warnings[0]}` : "";
  return `Motor: Stream Master token tips (set DUALPEER_DIRECT_MOTOR = true to skip).${warn}`;
}

function onLovenseReady(detail) {
  syncLovenseFromBridge();
  const ver = (detail && detail.version) || window.dualPeerLovense?.version;
  refreshLovenseStreamTokens().finally(() => {
    setLovenseStatus(
      `Extension ready${ver ? ` (v${ver})` : ""} — Site: ${window.dualPeerLovense?.getSiteName?.() || "test:Tangent-Club"}. ` +
        formatLovenseMotorStatus(detail)
    );
    if (els.lovenseToyStatus) {
      els.lovenseToyStatus.textContent = formatLovenseToys(
        (detail && detail.toys) || window.dualPeerLovense?.toys
      );
    }
    broadcastLocalToyInventory();
    renderLocalToyTestPanel({ force: true });
  });
}

function onLovenseError(detail) {
  syncLovenseFromBridge();
  lovenseReady = false;
  const code = detail && (detail.code || detail.error);
  if (code === "NO_SDK") return;
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
  broadcastLocalToyInventory();
  renderLocalToyTestPanel();
}

function bindLovenseEventsOnce() {
  if (lovenseEventsBound) return;
  lovenseEventsBound = true;
  document.addEventListener("dualpeer-lovense-ready", (e) => onLovenseReady(e.detail));
  document.addEventListener("dualpeer-lovense-error", (e) => onLovenseError(e.detail));
  document.addEventListener("dualpeer-lovense-toys", (e) => onLovenseToys(e.detail));
  document.addEventListener("dualpeer-lovense-settings", (e) => {
    syncLovenseFromBridge();
    const ver = window.dualPeerLovense?.version;
    setLovenseStatus(
      `Extension ready${ver ? ` (v${ver})` : ""} — Site: ${window.dualPeerLovense?.getSiteName?.() || "test:Tangent-Club"}. ` +
        formatLovenseMotorStatus(e.detail)
    );
    renderLocalToyTestPanel({ force: true });
  });
  document.addEventListener("dualpeer-lovense-tokens-sync", () => {
    renderLocalToyTestPanel();
  });
}

function refreshLovenseStreamTokens() {
  const bridge = window.dualPeerLovense;
  if (bridge && typeof bridge.refreshStreamSettings === "function") {
    return Promise.resolve(bridge.refreshStreamSettings()).then(() => renderLocalToyTestPanel());
  }
  return Promise.resolve();
}

function initLovenseIfPresent() {
  syncLovenseFromBridge();
  bindLovenseEventsOnce();
  updateLovenseSetupHint();
  renderLocalToyTestPanel();

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
    const pageUrl = location.origin + location.pathname;
    setLovenseStatus(
      `Waiting for Cam Extension (test:Tangent-Club) — open the Lovense widget on this tab (${pageUrl}), toggle extension On, then wait for ready.`
    );
    startLovenseConnectionWatch();
  }
}

function fireLovenseTip(amount, tipperName, toyId) {
  const requested = Math.round(Number(amount) || 0);
  if (!requested || requested < 1) return false;

  syncLovenseFromBridge();
  const bridge = window.dualPeerLovense;
  const name = String(tipperName || "Remote").slice(0, 40);
  const tokens = Math.max(25, requested);

  if (toyId && bridge && typeof bridge.vibrateToy === "function") {
    const result = bridge.vibrateToy(toyId, 100, tokens, name);
    return !!(result && result.ok);
  }

  const instance = bridge?.instance || camExtensionInstance;
  if (!instance || typeof instance.receiveTip !== "function") {
    console.warn("[Lovense] receiveTip unavailable", {
      hasBridge: !!bridge,
      bridgeReady: !!bridge?.ready,
      lovenseReady,
    });
    return false;
  }

  try {
    instance.receiveTip(tokens, name);
    return true;
  } catch (error) {
    console.error("fireLovenseTip failed:", error);
    if (bridge && typeof bridge.receiveTip === "function") {
      return bridge.receiveTip(tokens, name);
    }
  }
  return false;
}

function stopLocalLovenseToys(toyId) {
  syncLovenseFromBridge();
  const bridge = window.dualPeerLovense;
  if (bridge && toyId && typeof bridge.stopToy === "function") {
    return bridge.stopToy(toyId);
  }
  if (bridge && typeof bridge.stopToys === "function") {
    return bridge.stopToys();
  }
  return false;
}

function handleIncomingToyInventory(data) {
  if (!data || typeof data !== "object" || data.type !== "toy_inventory") return;
  const toys = Array.isArray(data.toys) ? data.toys.map(normalizeToyForPeer) : [];
  partnerRemoteToys = toys;
  renderToyControls(partnerRemoteToys);
  if (toys.length) {
    setDataActivityStatus(`Partner shared ${toys.length} toy(s) — remote control ready.`, "ok");
  } else {
    setDataActivityStatus("Partner has no toys connected.", "err");
  }
}

async function handleIncomingToyPayload(data) {
  if (!data || typeof data !== "object") return;
  if (data.type !== "toy") return;

  await ensureLovenseInitialized();

  const level = Math.max(0, Math.min(100, Number(data.level) || 0));
  const name = data.tipperName || "Partner";
  let tokens = Math.round(Number(data.tipAmount) || 0);
  const toyId = data.toyId ? String(data.toyId) : "";
  const toyLabel = toyId || "all toys";

  let ok = false;

  if (level <= 0) {
    const stopResult = await applyLovenseControl({ ...data, level: 0, tipAmount: 0 });
    ok = stopResult && typeof stopResult === "object" ? !!stopResult.ok : !!stopResult;
    if (!ok) ok = stopLocalLovenseToys(toyId);
    setDataActivityStatus(
      ok ? `Stop received for ${toyLabel}.` : `Stop received for ${toyLabel}.`,
      ok ? "ok" : "err"
    );
    return;
  }

  if (tokens < 1) {
    tokens = resolveTokensForToy(toyId, level, null);
  }
  if (tokens < 1) {
    setDataActivityStatus("Invalid intensity — could not map level to tokens.", "err");
    return;
  }

  pulseFor("local", 600 + level * 5);

  const tipTokens = tokens;
  let applyMethod = "none";
  const result = await applyLovenseControl({
    ...data,
    level,
    tipAmount: tipTokens,
    tipperName: name,
  });
  if (result && typeof result === "object") {
    ok = !!result.ok;
    applyMethod = result.method || "unknown";
  } else {
    ok = false;
    applyMethod = "no-bridge";
  }

  const methodLabel =
    applyMethod === "sendCommand"
      ? "motor hold until slider 0"
      : applyMethod === "receiveTip-hold" || applyMethod === "tipMessage-hold"
        ? "hold until stop"
        : applyMethod === "receiveTip"
          ? "extension tip"
          : applyMethod === "tipMessage"
            ? "targeted tip"
            : applyMethod;

  const resultHint =
    ok && applyMethod === "sendCommand" ? `Motor from ${name} — move slider to 0 to stop` : null;

  if (ok) {
    setLovenseStatus(`Remote control (${methodLabel}): ${toyLabel} from ${name}.`);
  }

  sendDataChannelMessage({
    type: "toy_ack",
    ok: !!ok,
    toyId,
    tokens: tipTokens,
    level,
    method: applyMethod,
    hint: ok ? resultHint : null,
    ts: Date.now(),
  });

  let failDetail = (result && result.hint) || lovenseNotReadyMessage();
  if (!ok && applyMethod === "no-lovense-api") {
    failDetail =
      "lovense.sendCommand not available — hard-reload host page. Without it, tips vibrate all toys.";
  } else if (!ok && applyMethod === "sendCommand-failed") {
    failDetail = "sendCommand failed for this toy ID — check extension widget and toy connection.";
  }

  setDataActivityStatus(
    ok
      ? `Applied level ${level} to ${toyLabel} only (${methodLabel}, ${tipTokens} tokens) from ${name}.`
      : `Command for ${toyLabel} failed — ${failDetail}`,
    ok ? "ok" : "err"
  );
}

async function handleIncomingToySpecialPayload(data) {
  if (!data || typeof data !== "object" || data.type !== "toy_special") return;

  await ensureLovenseInitialized();

  const toyId = data.toyId || "toy";
  const special = data.special || "special";
  const enabled = !!data.enabled;
  const name = data.tipperName || "Partner";
  const level = Math.max(0, Math.min(100, Number(data.level) || 0));
  let tipAmount = Math.round(Number(data.tipAmount) || 0);
  if (enabled && tipAmount < 1) {
    tipAmount = resolveSpecialTipAmount(toyId, special, level, tipAmount);
  }

  applyLovenseSpecial({
    toyId,
    special,
    enabled,
    tipperName: name,
    level,
    tipAmount,
  }).then((result) => {
    const ok = result && result.ok;
    const statusMsg = ok
      ? result.hint ||
        (enabled
          ? `Special ${special} on for ${toyId} (${result.tokens || tipAmount} tokens).`
          : `Special ${special} off for ${toyId} — base vibration restored.`)
      : result?.hint ||
        `Special ${special} failed for ${toyId} — check Stream Master Special Commands.`;
    setDataActivityStatus(statusMsg, ok ? "ok" : "err");
    sendDataChannelMessage({
      type: "toy_special_ack",
      ok: !!ok,
      toyId,
      special,
      enabled,
      hint: result?.hint || statusMsg,
      ts: Date.now(),
    });
  });
}

function setupDataConnection(conn) {
  if (!conn) return;
  if (conn._dualPeerWired) return;
  conn._dualPeerWired = true;

  dataConn = conn;
  updateConnectionUi();

  conn.on("data", handleIncomingDataMessage);
  conn.on("close", () => {
    if (dataConn === conn) {
      dataConn = null;
    }
    partnerRemoteToys = [];
    if (global.MemberProfile?.setPartnerProfile) MemberProfile.setPartnerProfile(null);
    renderToyControls([]);
    updateConnectionUi();
    setPeerStatus("Partner disconnected.", "err");
  });
  conn.on("open", () => {
    updateConnectionUi();
    broadcastLocalToyInventory();
    sendDataChannelMessage({ type: "toy_inventory_request", ts: Date.now() });
    shareMemberProfileOverDataChannel();
    sendDataChannelMessage({ type: "profile_request", ts: Date.now() });
  });
  conn.on("error", (err) => {
    setDataActivityStatus(
      "Data channel error: " + (err && err.message ? err.message : String(err)),
      "err"
    );
  });

  if (conn.open) {
    updateConnectionUi();
    broadcastLocalToyInventory();
    sendDataChannelMessage({ type: "toy_inventory_request", ts: Date.now() });
    shareMemberProfileOverDataChannel();
    sendDataChannelMessage({ type: "profile_request", ts: Date.now() });
  }
}

function onRemoteStream(remoteStream) {
  if (els.remoteVideo) {
    els.remoteVideo.srcObject = remoteStream;
    els.remoteVideo.muted = false;
    bindVideoOverlayRefresh(els.remoteVideo);
    bindStreamTrackRefresh(remoteStream);
    const playPromise = els.remoteVideo.play();
    if (playPromise && typeof playPromise.then === "function") {
      playPromise.then(() => scheduleOverlayRefreshBurst()).catch(() => scheduleOverlayRefreshBurst());
    }
  }
  scheduleOverlayRefreshBurst();
  syncRemoteMediaUi();
  updateConnectionUi();
}

function setupPeerHandlers() {
  peer.on("call", (call) => {
    const stream = getActiveLocalStream();
    if (stream) call.answer(stream);
    mediaConn = call;
    call.on("stream", onRemoteStream);
    call.on("close", () => {
      els.remoteVideo.srcObject = null;
      refreshVideoOverlays();
      resetRemoteMediaUi();
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
  notifySessionRole();
  const whipMode = getBroadcastMode() === "whip";

  try {
    peer = new Peer(undefined, PEER_OPTIONS);

    peer.on("open", async (id) => {
      els.peerIdOut.textContent = id;
      setupPeerHandlers();
      els.btnStartHost.disabled = true;
      publishHostPeerIdToGuest(id);

      try {
        if (whipMode) {
          await registerWhipBroadcast(id);
          setStatus(
            els.statusHost,
            "Paste WHIP URL into OBS and click Start Streaming. Waiting for OBS…",
            "ok"
          );
          await startWhipSessionMedia();
        } else {
          await startSessionMedia();
        }
        setStatus(els.statusHost, "Waiting for incoming connection … share Peer ID with partner.", "ok");
      } catch (err) {
        setStatus(els.statusHost, String(err.message || err), "err");
        els.btnStartHost.disabled = !videoAccessUnlocked;
      }
    });

    peer.on("error", (err) => {
      setStatus(els.statusHost, String(err.message || err), "err");
    });
  } catch (e) {
    setStatus(els.statusHost, "Media access: " + formatMediaAccessError(e), "err");
  }
});

els.btnConnect.addEventListener("click", async () => {
  const remoteId = (els.peerIdIn.value || "").trim();
  if (!remoteId) {
    setStatus(els.statusGuest, "Please enter the partner Session ID.", "err");
    return;
  }
  if (global.DualPeerSocial?.checkConnectAvailable) {
    try {
      const check = await global.DualPeerSocial.checkConnectAvailable({ hostPeerId: remoteId });
      if (!check?.available) {
        setStatus(
          els.statusGuest,
          check?.message ||
            "Your partner is in another session. Please try again later.",
          "err"
        );
        return;
      }
    } catch (err) {
      if (err?.status === 409 || err?.code === "provider_busy") {
        setStatus(
          els.statusGuest,
          err.message ||
            "Your partner is in another session. Please try again later.",
          "err"
        );
        return;
      }
    }
  }
  hangup();
  sessionRole = "guest";
  notifySessionRole();
  try {
    await startSessionMedia();
    peer = new Peer(undefined, PEER_OPTIONS);

    peer.on("open", (myId) => {
      els.peerIdOut.textContent = myId;
      setupPeerHandlers();

      const stream = getActiveLocalStream();
      const call = stream ? peer.call(remoteId, stream) : null;
      if (call) {
        mediaConn = call;
        call.on("stream", onRemoteStream);
        call.on("close", () => {
          els.remoteVideo.srcObject = null;
          refreshVideoOverlays();
          resetRemoteMediaUi();
          updateConnectionUi();
        });
      }

      const conn = peer.connect(remoteId, { reliable: true, serialization: "json" });
      setupDataConnection(conn);

      updateConnectionUi();
      els.btnConnect.disabled = true;
      els.btnStartHost.disabled = true;
    });

    peer.on("error", (err) => {
      setStatus(els.statusGuest, String(err.message || err), "err");
    });
  } catch (e) {
    setStatus(els.statusGuest, "Media access: " + formatMediaAccessError(e), "err");
  }
});

els.btnHangup.addEventListener("click", () => hangup());
const btnHangupStream = document.getElementById("btnHangupStream");
if (btnHangupStream) btnHangupStream.addEventListener("click", () => hangup());

window.addEventListener("beforeunload", () => hangup());

function sendTechniqueRequest(techniqueId, label, fromName) {
  const ts = Date.now();
  appendChatTechniqueMessage(fromName, label, true, ts);
  if (!dataConn?.open) {
    setDataActivityStatus("Technique saved to chat — connect for partner to see it.", "");
    return;
  }
  sendDataChannelMessage({
    type: "technique_request",
    techniqueId,
    label,
    fromName,
    ts,
  });
}

function initMemberProfileBridge() {
  window.addEventListener("dualpeer-technique-request", (e) => {
    const { techniqueId, label, fromName } = e.detail || {};
    sendTechniqueRequest(techniqueId, label, fromName);
  });
  window.addEventListener("dualpeer-technique-request-incoming", (e) => {
    const { label, fromName, ts } = e.detail || {};
    appendChatTechniqueMessage(fromName, label, false, ts);
    playTechniqueBell();
  });
  window.addEventListener("dualpeer-profile-share-request", () => {
    shareMemberProfileOverDataChannel();
  });
}

function applyAccountStreamingUi() {
  if (!videoAccessUnlocked) return;
  if (els.btnStartHost) {
    els.btnStartHost.disabled = false;
    els.btnStartHost.title = "Start your camera and share a Session ID";
  }
  if (els.btnConnect) {
    els.btnConnect.disabled = false;
    els.btnConnect.title = "Join your partner's live session";
  }
  global.DualPeerSocial?.updateSessionActionHighlight?.();
}

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
  setMediaSourceControlsEnabled(unlocked);
  if (els.btnStartHost) els.btnStartHost.disabled = !unlocked;
  if (els.btnConnect) els.btnConnect.disabled = !unlocked;
  if (unlocked) {
    refreshMediaDeviceLists().catch(() => {});
    applyAccountStreamingUi();
  } else {
    setMediaSourceStatus("");
  }
}

let lovenseUiBooted = false;
let lovenseBootInFlight = false;
let lovenseEventsBound = false;

/** Load LAN SDK + Cam Extension bridge only when user opens Lovense-related UI. */
async function ensureLovenseInitialized() {
  if (lovenseBootInFlight) {
    while (lovenseBootInFlight) {
      await new Promise((r) => setTimeout(r, 40));
    }
    return;
  }
  lovenseBootInFlight = true;
  try {
    if (typeof loadLovenseLanScript === "function") {
      await loadLovenseLanScript().catch(() => false);
    }
    window.dualPeerLovense?.requestBoot?.();
    if (!lovenseUiBooted) {
      lovenseUiBooted = true;
      initLovenseIfPresent();
      startLovenseConnectionWatch();
    } else {
      initLovenseIfPresent();
      if (typeof window.dualPeerLovense?.retryInit === "function") {
        window.dualPeerLovense.retryInit();
      }
      if (window.dualPeerLovense?.ready) {
        window.dualPeerLovense.refreshStreamSettings?.().catch(() => null);
      }
    }
    updateLovensePatternUrl();
  } finally {
    lovenseBootInFlight = false;
  }
}

/** Host-side Lovense command (local test + partner remote) — always load LAN SDK first. */
async function applyLovenseControl(payload) {
  await ensureLovenseInitialized();
  const bridge = window.dualPeerLovense;
  if (!bridge?.ready) {
    return {
      ok: false,
      method: "not-ready",
      hint: "Extension not ready — open Lovense widget on this tab (test:Tangent-Club, On).",
    };
  }
  if (isDirectMotorMode() && typeof loadLovenseLanScript === "function") {
    await loadLovenseLanScript().catch(() => false);
    if (typeof bridge.refreshStreamSettings === "function") {
      await bridge.refreshStreamSettings().catch(() => null);
    }
    if (window.dualPeerLovense?.ready && typeof window.lovense === "undefined") {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  if (!bridge || typeof bridge.applyRemoteControl !== "function") {
    return { ok: false, method: "no-bridge", hint: "Lovense bridge not ready." };
  }
  return bridge.applyRemoteControl(payload);
}

async function applyLovenseSpecial(payload) {
  await ensureLovenseInitialized();
  const bridge = window.dualPeerLovense;
  if (!bridge || typeof bridge.applyToySpecial !== "function") {
    return { ok: false, method: "no-bridge", hint: "Lovense not ready." };
  }
  return bridge.applyToySpecial(payload);
}

function updateLovensePatternUrl() {
  const el = document.getElementById("lovensePatternUrl");
  if (el) el.textContent = location.origin + location.pathname;
}

function initLovenseLazyBoot() {
  const trigger = (e) => {
    const hit = e.target?.closest?.(
      '[data-panel-tab="setup"], [data-panel-tab="stream"], [data-remote-tab="toys"], #localToyTestList, .local-test-card, #btnLovenseRetry'
    );
    if (hit) ensureLovenseInitialized();
  };
  document.addEventListener("click", trigger);
  document.addEventListener("dualpeer-panel-tab", () => {
    ensureLovenseInitialized();
  });
  const retryBtn = document.getElementById("btnLovenseRetry");
  if (retryBtn) {
    retryBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      lovenseUiBooted = false;
      setLovenseStatus("Reconnecting Lovense extension…");
      await ensureLovenseInitialized();
    });
  }
  updateLovensePatternUrl();
}

function grantSiteAccess() {
  try {
    sessionStorage.setItem(SESSION_VIDEO_UNLOCK_KEY, "1");
  } catch (_) {
    /* ignore */
  }
  setVideoAccessUi(true);
  const pass = document.getElementById("accessPassword");
  if (pass instanceof HTMLInputElement) pass.value = "";
}

function revokeSiteAccess() {
  try {
    sessionStorage.removeItem(SESSION_VIDEO_UNLOCK_KEY);
  } catch (_) {
    /* ignore */
  }
  setVideoAccessUi(false);
}

window.dualPeerSiteAccess = {
  grant: grantSiteAccess,
  revoke: revokeSiteAccess,
};

function initAccessGate() {
  setVideoAccessUi(false);

  global.addEventListener("dualpeer-site-access-granted", () => {
    grantSiteAccess();
    initLovenseIfPresent();
    ensureLovenseInitialized();
  });
  global.addEventListener("dualpeer-site-access-revoked", () => {
    revokeSiteAccess();
  });

  if (global.DualPeerAuth?.onReady) {
    global.DualPeerAuth.onReady(() => {
      if (global.DualPeerAuth.isLoggedIn()) {
        grantSiteAccess();
        initLovenseIfPresent();
        ensureLovenseInitialized();
      }
    });
  }

  global.addEventListener("dualpeer-auth-change", () => {
    applyAccountStreamingUi();
  });
  global.addEventListener("dualpeer-account-role-change", () => {
    applyAccountStreamingUi();
  });

  requestAnimationFrame(() => {
    document.getElementById("accessUsername")?.focus();
  });
}


async function performAppLogout() {
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
  if (global.DualPeerAuth?.logout) {
    await global.DualPeerAuth.logout();
  } else {
    global.dispatchEvent(new CustomEvent("dualpeer-logout-request"));
  }
  if (global.dualPeerSiteAccess?.revoke) global.dualPeerSiteAccess.revoke();
  else global.dispatchEvent(new CustomEvent("dualpeer-site-access-revoked"));
}

function initLogout() {
  const btn = els.logoutBtn;
  if (!btn) return;

  btn.addEventListener("click", async () => {
    await performAppLogout();
    location.reload();
  });
}

global.dualPeerPerformLogout = performAppLogout;

let lovenseWatchTimer = null;

function startLovenseConnectionWatch() {
  if (lovenseWatchTimer) return;
  let ticks = 0;
  lovenseWatchTimer = setInterval(() => {
    syncLovenseFromBridge();
    const bridge = window.dualPeerLovense;
    if (bridge?.ready) {
      clearInterval(lovenseWatchTimer);
      lovenseWatchTimer = null;
      onLovenseReady({ version: bridge.version, toys: bridge.toys });
      return;
    }
    if (bridge?.error?.code === "NO_SDK") {
      clearInterval(lovenseWatchTimer);
      lovenseWatchTimer = null;
      onLovenseError(bridge.error);
      return;
    }
    ticks += 1;
    if (ticks === 2 || ticks === 6 || ticks === 12) {
      if (typeof bridge?.retryInit === "function") bridge.retryInit();
    }
    if (ticks % 4 === 0) {
      const pageUrl = location.origin + location.pathname;
      const hasInstance = !!bridge?.instance;
      setLovenseStatus(
        (hasInstance ? "CamExtension started — " : "") +
          `waiting for extension on ${pageUrl}. Chrome: Lovense icon → On → site test:Tangent-Club. Open the pink widget on this page.`
      );
    }
    if (ticks >= 60) {
      clearInterval(lovenseWatchTimer);
      lovenseWatchTimer = null;
    }
  }, 2000);
}

function lovenseNotReadyMessage() {
  syncLovenseFromBridge();
  const bridge = window.dualPeerLovense;
  const instance = bridge?.instance || camExtensionInstance;

  if (typeof CamExtension === "undefined") {
    return "broadcast.js not loaded.";
  }
  if (!bridge) {
    return "lovense-broadcast.js not loaded.";
  }
  if (bridge.error) {
    const e = bridge.error;
    return (e.message || e.code || "SDK error") + " — check URL in Lovense dashboard.";
  }
  if (!instance) {
    return "CamExtension not initialized yet — wait for Extension ready on the host page.";
  }
  if (!bridge.ready && !lovenseReady) {
    return "Extension not ready — in Chrome select test:Tangent-Club and verify widget on this page.";
  }
  if (typeof instance.receiveTip !== "function") {
    return "receiveTip not available on CamExtension instance.";
  }
  return "receiveTip call failed — check host tab is open and extension is connected.";
}

function getActiveLocalStream() {
  if (localStream && localStream.active !== false) {
    window.localStream = localStream;
    return localStream;
  }
  if (window.localStream && window.localStream.active !== false) {
    localStream = window.localStream;
    return window.localStream;
  }
  const fromVideo = els.localVideo?.srcObject;
  if (fromVideo instanceof MediaStream) {
    localStream = fromVideo;
    window.localStream = fromVideo;
    return fromVideo;
  }
  return null;
}

const MEDIA_ICON = {
  micOn: "bi-mic",
  micOff: "bi-mic-mute",
  camOn: "bi-camera-video",
  camOff: "bi-camera-video-off",
};

function setIconState(iconEl, baseClass, offClass, isOff) {
  if (!iconEl) return;
  iconEl.className = `bi ${isOff ? offClass : baseClass} video-ctrl-icon`;
}

function formatMediaAccessError(err) {
  const raw = String(err && err.message ? err.message : err || "Unknown error");
  const lower = raw.toLowerCase();
  if (/denied|not allowed|permission|zugriff|verweigert/.test(lower)) {
    return "Media access denied — allow camera and microphone in browser settings.";
  }
  if (/not found|unavailable|nicht gefunden|nicht verfügbar/.test(lower)) {
    return "Camera or microphone not available — check devices and permissions.";
  }
  return raw;
}

function setControlButtonState(btn, isOff, tooltipOn, tooltipOff, labelOn, labelOff) {
  if (!btn) return;
  const off = !!isOff;
  btn.classList.toggle("is-off", off);
  const tooltip = off ? tooltipOff : tooltipOn;
  const label = off ? labelOff : labelOn;
  btn.dataset.tooltip = tooltip;
  btn.setAttribute("aria-label", label);
}

function setLocalControlsEnabled(enabled) {
  if (els.localVideoControls) {
    els.localVideoControls.classList.toggle("is-ready", enabled);
  }
  if (els.localToggleMuteBtn) els.localToggleMuteBtn.disabled = !enabled;
  if (els.localToggleVideoBtn) els.localToggleVideoBtn.disabled = !enabled;
}

function setRemoteControlsEnabled(enabled) {
  if (els.remoteVideoControls) {
    els.remoteVideoControls.hidden = !enabled;
    els.remoteVideoControls.classList.toggle("is-ready", enabled);
  }
  if (els.remoteToggleMuteBtn) els.remoteToggleMuteBtn.disabled = !enabled;
  if (els.remoteToggleVideoBtn) els.remoteToggleVideoBtn.disabled = !enabled;
}

function resetLocalMediaUi() {
  setLocalControlsEnabled(false);
  setIconState(els.localMuteIcon, MEDIA_ICON.micOn, MEDIA_ICON.micOff, false);
  setIconState(els.localVideoIcon, MEDIA_ICON.camOn, MEDIA_ICON.camOff, false);
  setControlButtonState(
    els.localToggleMuteBtn,
    false,
    "Mute Audio",
    "Unmute Audio",
    "Mute Audio",
    "Unmute Audio"
  );
  setControlButtonState(
    els.localToggleVideoBtn,
    false,
    "Stop Video",
    "Start Video",
    "Stop Video",
    "Start Video"
  );
}

function resetRemoteMediaUi() {
  setRemoteControlsEnabled(false);
  if (els.remoteVideo) {
    els.remoteVideo.muted = false;
    els.remoteVideo.style.opacity = "1";
    delete els.remoteVideo.dataset.videoHidden;
  }
  setIconState(els.remoteMuteIcon, MEDIA_ICON.micOn, MEDIA_ICON.micOff, false);
  setIconState(els.remoteVideoIcon, MEDIA_ICON.camOn, MEDIA_ICON.camOff, false);
  setControlButtonState(
    els.remoteToggleMuteBtn,
    false,
    "Mute Audio",
    "Unmute Audio",
    "Mute Audio",
    "Unmute Audio"
  );
  setControlButtonState(
    els.remoteToggleVideoBtn,
    false,
    "Stop Video",
    "Start Video",
    "Stop Video",
    "Start Video"
  );
}

function syncLocalMediaUi() {
  const stream = getActiveLocalStream();
  if (!stream) {
    resetLocalMediaUi();
    return;
  }

  setLocalControlsEnabled(true);
  attachLocalVideoStream(stream);

  const audioTracks = stream.getAudioTracks();
  const videoTracks = stream.getVideoTracks();
  const isMuted = audioTracks.length > 0 && !audioTracks.every((t) => t.enabled);
  const isVideoOff = videoTracks.length > 0 && !videoTracks.every((t) => t.enabled);

  setIconState(els.localMuteIcon, MEDIA_ICON.micOn, MEDIA_ICON.micOff, isMuted);
  setIconState(els.localVideoIcon, MEDIA_ICON.camOn, MEDIA_ICON.camOff, isVideoOff);
  setControlButtonState(
    els.localToggleMuteBtn,
    isMuted,
    "Mute Audio",
    "Unmute Audio",
    "Mute Audio",
    "Unmute Audio"
  );
  setControlButtonState(
    els.localToggleVideoBtn,
    isVideoOff,
    "Stop Video",
    "Start Video",
    "Stop Video",
    "Start Video"
  );
}

function syncRemoteMediaUi() {
  const hasRemote =
    els.remoteVideo?.srcObject instanceof MediaStream &&
    els.remoteVideo.srcObject.getTracks().some((t) => t.readyState !== "ended");

  if (!hasRemote) {
    resetRemoteMediaUi();
    return;
  }

  setRemoteControlsEnabled(true);

  const playbackMuted = !!els.remoteVideo?.muted;
  const videoHidden = els.remoteVideo?.dataset.videoHidden === "1";

  setIconState(els.remoteMuteIcon, MEDIA_ICON.micOn, MEDIA_ICON.micOff, playbackMuted);
  setIconState(els.remoteVideoIcon, MEDIA_ICON.camOn, MEDIA_ICON.camOff, videoHidden);
  setControlButtonState(
    els.remoteToggleMuteBtn,
    playbackMuted,
    "Mute Audio",
    "Unmute Audio",
    "Mute Audio",
    "Unmute Audio"
  );
  setControlButtonState(
    els.remoteToggleVideoBtn,
    videoHidden,
    "Stop Video",
    "Start Video",
    "Stop Video",
    "Start Video"
  );
}

function toggleLocalAudio() {
  const stream = getActiveLocalStream();
  if (!stream) return false;

  const tracks = stream.getAudioTracks();
  if (!tracks.length) return false;

  const isMuted = tracks.every((t) => !t.enabled);
  const enable = isMuted;
  tracks.forEach((track) => {
    track.enabled = enable;
  });
  window.localStream = stream;
  syncLocalMediaUi();
  return true;
}

function toggleLocalVideo() {
  const stream = getActiveLocalStream();
  if (!stream) return false;

  const tracks = stream.getVideoTracks();
  if (!tracks.length) return false;

  const isOff = tracks.every((t) => !t.enabled);
  const enable = isOff;
  tracks.forEach((track) => {
    track.enabled = enable;
  });
  window.localStream = stream;
  syncLocalMediaUi();
  refreshVideoOverlays();
  return true;
}

function toggleRemotePlaybackAudio() {
  if (!els.remoteVideo?.srcObject) return false;
  els.remoteVideo.muted = !els.remoteVideo.muted;
  syncRemoteMediaUi();
  return true;
}

function toggleRemotePlaybackVideo() {
  if (!els.remoteVideo?.srcObject) return false;
  const hidden = els.remoteVideo.dataset.videoHidden === "1";
  els.remoteVideo.dataset.videoHidden = hidden ? "0" : "1";
  els.remoteVideo.style.opacity = hidden ? "1" : "0";
  syncRemoteMediaUi();
  return true;
}

function initVideoOverlayControls() {
  if (els.localToggleMuteBtn) {
    els.localToggleMuteBtn.addEventListener("click", () => {
      toggleLocalAudio();
    });
  }

  if (els.localToggleVideoBtn) {
    els.localToggleVideoBtn.addEventListener("click", () => {
      toggleLocalVideo();
    });
  }

  if (els.remoteToggleMuteBtn) {
    els.remoteToggleMuteBtn.addEventListener("click", () => {
      toggleRemotePlaybackAudio();
    });
  }

  if (els.remoteToggleVideoBtn) {
    els.remoteToggleVideoBtn.addEventListener("click", () => {
      toggleRemotePlaybackVideo();
    });
  }

  resetLocalMediaUi();
  resetRemoteMediaUi();
}

function initModelPoolActions() {
  const root = document.getElementById("modelPoolList");
  const status = document.getElementById("modelPoolStatus");
  if (!root || !status) return;
  const DEMO_MODELS = [
    {
      id: "",
      username: "anna_demo",
      displayName: "Anna Blaze (Demo)",
      online: true,
      availabilityText: "Online now · Demo profile",
      isDemo: true,
    },
    {
      id: "",
      username: "sophia_demo",
      displayName: "Sophia V (Demo)",
      online: false,
      availabilityText: "Available today 18:00-23:00 · Demo profile",
      isDemo: true,
    },
    {
      id: "",
      username: "jade_demo",
      displayName: "Jade River (Demo)",
      online: true,
      availabilityText: "Online now · Roleplay focus · Demo profile",
      isDemo: true,
    },
  ];

  const renderModels = (models) => {
    root.innerHTML = "";
    const list = Array.isArray(models) && models.length > 0 ? models : DEMO_MODELS;
    list.forEach((model) => {
      const card = document.createElement("div");
      card.className = "model-card";
      const name = document.createElement("strong");
      name.textContent = model.displayName || model.username || "Model";
      const meta = document.createElement("span");
      const availability = model.availabilityText || "Availability not set";
      meta.textContent = `${model.online ? "Online now" : "Offline"} · ${availability}`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "secondary model-request-btn";
      btn.textContent = "Request session";
      btn.dataset.modelName = model.displayName || model.username || "Model";
      btn.dataset.modelUserId = model.id || "";
      if (model.isDemo) btn.dataset.modelDemo = "1";
      card.appendChild(name);
      card.appendChild(meta);
      card.appendChild(btn);
      root.appendChild(card);
    });
  };

  const loadModels = async () => {
    const auth = window.DualPeerAuth;
    if (!auth?.isLoggedIn?.()) {
      root.innerHTML = "";
      status.className = "status-line";
      status.textContent = "Sign in to load your model pool.";
      return;
    }
    status.className = "status-line";
    status.textContent = "Loading model pool...";
    try {
      if (global.DualPeerSocial?.loadModelPool) {
        await global.DualPeerSocial.loadModelPool();
        const count = global.DualPeerSocial.getModelPool?.().length || 0;
        status.className = "status-line ok";
        status.textContent = count > 0 ? `${count} model(s) in your pool.` : "Invite models by email from the account menu.";
        return;
      }
      const result = await auth.fetchPremiumModels();
      renderModels(result?.models || []);
      const count = (result?.models || []).length;
      status.className = "status-line ok";
      status.textContent = count > 0 ? `${count} model(s) loaded.` : "No models in pool yet.";
    } catch (err) {
      renderModels([]);
      status.className = "status-line err";
      status.textContent = "Could not load model pool.";
    }
  };

  root.addEventListener("click", async (e) => {
    const btn = e.target?.closest?.(".model-request-btn");
    if (!btn) return;
    const auth = window.DualPeerAuth;
    if (!auth?.isLoggedIn?.()) {
      status.className = "status-line err";
      status.textContent = "Please sign in before booking a model.";
      return;
    }
    const modelName = btn.getAttribute("data-model-name") || "Model";
    if (btn.dataset.modelDemo === "1") {
      status.className = "status-line err";
      status.textContent =
        `${modelName} is a demo profile. Create a real Premium+Model account in Admin to enable booking.`;
      return;
    }
    const modelUserId = String(btn.getAttribute("data-model-user-id") || "").trim();
    if (!modelUserId) {
      status.className = "status-line err";
      status.textContent = `Model user ID missing for ${modelName}.`;
      return;
    }
    const now = Date.now();
    const startAt = now + 10 * 60 * 1000;
    const endAt = startAt + 30 * 60 * 1000;
    btn.disabled = true;
    status.className = "status-line";
    status.textContent = `Sending booking request to ${modelName}...`;
    try {
      const result = await auth.bookModel({
        modelUserId,
        scheduledStartAt: startAt,
        scheduledEndAt: endAt,
        currency: "EUR",
        totalAmountMinor: 0,
        platformFeeMinor: 0,
        modelPayoutMinor: 0,
        guestNote: "Model pool booking request",
      });
      status.className = "status-line ok";
      status.textContent =
        result?.message || `${modelName} received your booking request. Waiting for acceptance.`;
    } catch (err) {
      status.className = "status-line err";
      status.textContent = err?.message || `Booking request failed for ${modelName}.`;
    } finally {
      btn.disabled = false;
    }
  });

  window.addEventListener("dualpeer-auth-change", () => {
    loadModels();
  });

  loadModels();
}


document.addEventListener("DOMContentLoaded", () => {
  if (window.dualPeerUi) {
    window.dualPeerUi.initShell();
  }
  bindVideoOverlayRefresh(els.localVideo);
  bindVideoOverlayRefresh(els.remoteVideo);
  refreshVideoOverlays();
  initAccessGate();
  initLovenseIfPresent();
  ensureLovenseInitialized();
  initLovenseLazyBoot();
  initLogout();
  initMediaSourceControls();
  initVideoOverlayControls();
  initLayoutControls();
  initChatControls();
  initDynamicToyControls();
  initModelPoolActions();
  initLocalToyTestPanel();
  initMemberProfileBridge();
});