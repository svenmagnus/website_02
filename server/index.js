/**
 * WHIP ingest (OBS → server) + WHEP playback (server → host browser → PeerJS guest).
 *
 * Endpoints:
 *   POST   /api/broadcast/register     → create stream key + URLs for host UI
 *   GET    /api/broadcast/:streamKey/status
 *   POST   /whip/:streamKey            → WHIP ingest (SDP offer from OBS)
 *   DELETE /whip/:streamKey/:resourceId
 *   POST   /whep/:streamKey            → WHEP playback (SDP offer from browser)
 *   DELETE /whep/:streamKey/:resourceId
 */
import cors from "cors";
import express from "express";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initDb } from "./db.js";
import { authRouter } from "./auth-routes.js";
import { WhipReceiver } from "@werift/whip-server";
import {
  RTCPeerConnection,
  useAV1X,
  useH264,
  useOPUS,
  useSdesRTPStreamId,
  useVP8,
  useVP9,
} from "werift";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(__dirname, "..");

const PORT = Number(process.env.PORT) || 8787;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const STATIC_KEYS = new Set(
  (process.env.STREAM_KEYS || "dev-test-stream-key-change-me")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
);

/** @type {Map<string, { peerId?: string, createdAt: number }>} */
const registeredKeys = new Map();

/** @type {Map<string, WhipSession>} */
const whipSessions = new Map();

/** @type {Map<string, WhepSession>} */
const whepSessions = new Map();

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: [
      "turn:openrelay.metered.ca:3478?transport=udp",
      "turn:openrelay.metered.ca:3478?transport=tcp",
    ],
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

function trackId(track) {
  return track?.uuid ?? track?.id ?? null;
}

/** Latest ingest track per kind on the WHIP peer connection. */
function getIngestTransceiverTracks(session, { strictDirection = true } = {}) {
  const byKind = new Map();
  for (const tx of session.pc?.getTransceivers() || []) {
    const track = tx.receiver?.track;
    if (!track) continue;
    if (strictDirection) {
      const direction = tx.currentDirection || tx.direction;
      if (direction === "sendonly") continue;
    }
    byKind.set(track.kind, track);
  }
  return byKind;
}

/** WhipReceiver.onTrack can miss tracks; mirror live transceiver tracks when needed. */
function backfillWhipReceiver(session) {
  const { whipReceiver } = session;
  if (!whipReceiver) return;
  const byKind = getIngestTransceiverTracks(session, { strictDirection: false });
  const audio = byKind.get("audio");
  const video = byKind.get("video");
  if (audio) whipReceiver.audio = audio;
  if (video) {
    if (!whipReceiver.video?.length) whipReceiver.video = [video];
    else whipReceiver.video[whipReceiver.video.length - 1] = video;
  }
}

/** Tracks on WHIP transceivers only (never stale WhipReceiver fallbacks). */
function getIngestRelayTracks(session) {
  const t = session.ingestTracks || {};
  return [t.audio, t.video].filter(Boolean);
}

function whipTransceiversReady(session) {
  return !!(session.ingestTracks?.audio && session.ingestTracks?.video);
}

/** @deprecated Use ingestTracks from onTrack; kept for one-shot backfill after connect. */
function getActiveWhipTracks(session) {
  const fromIngest = getIngestRelayTracks(session);
  if (fromIngest.length) return fromIngest;
  let byKind = getIngestTransceiverTracks(session, { strictDirection: true });
  let tracks = [byKind.get("audio"), byKind.get("video")].filter(Boolean);
  if (tracks.length < 2) {
    byKind = getIngestTransceiverTracks(session, { strictDirection: false });
    tracks = [byKind.get("audio"), byKind.get("video")].filter(Boolean);
  }
  return tracks;
}

function whipReceiverReady(session) {
  return whipTransceiversReady(session);
}

function waitForWhipTracks(session, timeoutMs = 10000) {
  harvestIngestTracks(session);
  if (whipReceiverReady(session)) return Promise.resolve(getIngestRelayTracks(session));
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      harvestIngestTracks(session);
      if (whipReceiverReady(session)) return resolve(getIngestRelayTracks(session));
      if (Date.now() >= deadline) {
        return reject(new Error("WHIP tracks not received in time"));
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

function noteWhipRtp(session, track) {
  if (!track?.onReceiveRtp) return;
  const id = trackId(track);
  if (!id) return;
  session._rtpBoundIds = session._rtpBoundIds || new Set();
  if (session._rtpBoundIds.has(id)) return;
  session._rtpBoundIds.add(id);
  track.onReceiveRtp.once(() => {
    session.rtpSeen = session.rtpSeen || { audio: false, video: false };
    session.rtpSeen[track.kind] = true;
    session.updatedAt = Date.now();
    console.log(`[WHIP] rtp ${track.kind} id=${id} key=${session.streamKey}`);
    if (track.kind === "video") {
      session.live = true;
      rebindWhepRelay(session);
    }
  });
}

function bindWhipRtpHandlers(session) {
  for (const track of getIngestRelayTracks(session)) {
    noteWhipRtp(session, track);
  }
}

function waitForWhipVideoRtp(session, timeoutMs = 15000) {
  bindAllTransceiverRtp(session);
  if (session.rtpSeen?.video) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      bindAllTransceiverRtp(session);
      if (session.rtpSeen?.video) return resolve();
      if (Date.now() >= deadline) {
        return reject(new Error("WHIP video RTP not received in time"));
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

function registerWhipTrack(session, track) {
  if (!track) return;
  const idx = session.tracks.findIndex((t) => t.kind === track.kind);
  const prev = idx >= 0 ? session.tracks[idx] : null;
  if (prev === track) return;
  if (prev) session.tracks[idx] = track;
  else session.tracks.push(track);
  session.updatedAt = Date.now();
  session.live = session.tracks.some((t) => t.kind === "video");
  const prevId = prev?.uuid ?? prev?.id;
  const nextId = track.uuid ?? track.id ?? "?";
  if (prevId !== nextId) {
    console.log(`[WHIP] track ${track.kind} id=${nextId} key=${session.streamKey}`);
  }
}

function syncWhipTracksFromPc(session) {
  for (const track of getIngestRelayTracks(session)) {
    registerWhipTrack(session, track);
  }
}

function adoptIngestTrack(session, track, source, { log = false } = {}) {
  if (!track) return false;
  session.ingestTracks = session.ingestTracks || { audio: null, video: null };
  const prev = session.ingestTracks[track.kind];
  const prevId = trackId(prev);
  const nextId = trackId(track);
  if (prev && prevId === nextId) return false;
  if (prev) return false;

  session.ingestTracks[track.kind] = track;
  registerWhipTrack(session, track);
  noteWhipRtp(session, track);
  if (log) {
    console.log(`[WHIP] ${source} ${track.kind} id=${nextId ?? "?"} key=${session.streamKey}`);
  }
  return true;
}

function bindAllTransceiverRtp(session) {
  for (const tx of session.pc?.getTransceivers() || []) {
    const track = tx.receiver?.track;
    if (track) noteWhipRtp(session, track);
  }
}

function bindWhipTransceiverHandlers(session) {
  if (session._txHandlersBound) return;
  session._txHandlersBound = true;

  const bindTx = (tx) => {
    tx.onTrack.subscribe((track) => {
      if (adoptIngestTrack(session, track, "onTrack", { log: true })) {
        rebindWhepRelay(session);
      } else {
        noteWhipRtp(session, track);
      }
    });
    const existing = tx.receiver?.track;
    if (existing) {
      adoptIngestTrack(session, existing, "transceiver", { log: true });
      noteWhipRtp(session, existing);
    }
  };

  session.pc.onTransceiverAdded.subscribe((tx) => bindTx(tx));
  for (const tx of session.pc.getTransceivers()) bindTx(tx);
}

function getLiveWhipRelayTracks(session) {
  const byKind = getIngestTransceiverTracks(session, { strictDirection: false });
  const out = new Map();
  for (const kind of ["audio", "video"]) {
    const live = byKind.get(kind);
    if (live) out.set(kind, live);
    else if (session.ingestTracks?.[kind]) out.set(kind, session.ingestTracks[kind]);
  }
  return out;
}

function logWhipTransceivers(session) {
  const txs = session.pc?.getTransceivers() || [];
  const parts = txs.map((tx, i) => {
    const direction = tx.currentDirection || tx.direction || "?";
    return `${i}:${tx.kind}/${direction}/${trackId(tx.receiver?.track) ?? "none"}`;
  });
  console.log(
    `[WHIP] transceivers=${txs.length}${parts.length ? ` [${parts.join(", ")}]` : ""} key=${session.streamKey}`
  );
}

/** Fill ingestTracks from WhipReceiver + PC transceivers (first track per kind only). */
function harvestIngestTracks(session, { log = false } = {}) {
  session.ingestTracks = session.ingestTracks || { audio: null, video: null };
  const { whipReceiver } = session;
  if (whipReceiver?.audio) {
    adoptIngestTrack(session, whipReceiver.audio, "whipReceiver", { log });
  }
  const videos = whipReceiver?.video;
  if (videos?.length) {
    adoptIngestTrack(session, videos[videos.length - 1], "whipReceiver", { log });
  }

  let byKind = getIngestTransceiverTracks(session, { strictDirection: false });
  if (!byKind.has("audio") || !byKind.has("video")) {
    byKind = getIngestTransceiverTracks(session, { strictDirection: true });
  }
  for (const kind of ["audio", "video"]) {
    adoptIngestTrack(session, byKind.get(kind), "transceiver", { log });
  }
  bindAllTransceiverRtp(session);
  return whipTransceiversReady(session);
}

function startIngestTrackPoll(session) {
  if (session._ingestPoll) return;
  let attempts = 0;
  session._ingestPoll = setInterval(() => {
    if (whipSessions.get(session.streamKey) !== session) {
      clearInterval(session._ingestPoll);
      session._ingestPoll = null;
      return;
    }
    harvestIngestTracks(session, { log: false });
    bindAllTransceiverRtp(session);
    if (session.rtpSeen?.video) {
      clearInterval(session._ingestPoll);
      session._ingestPoll = null;
      rebindWhepRelay(session);
    } else if (++attempts >= 80) {
      clearInterval(session._ingestPoll);
      session._ingestPoll = null;
      logWhipTransceivers(session);
      console.warn(`[WHIP] no video RTP after 20s key=${session.streamKey}`);
    }
  }, 250);
}

function bindWhipTrackHandler(session) {
  session.ingestTracks = { audio: null, video: null };
  let rebindTimer = null;
  const scheduleRebind = () => {
    if (!whipTransceiversReady(session)) return;
    clearTimeout(rebindTimer);
    rebindTimer = setTimeout(() => rebindWhepRelay(session), 100);
  };

  session.whipReceiver.onTrack.subscribe((track) => {
    if (!track) return;
    if (adoptIngestTrack(session, track, "onTrack", { log: true })) {
      scheduleRebind();
    } else {
      noteWhipRtp(session, track);
    }
  });
}

function waitWeriftIceGathering(pc, timeoutMs = 8000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    pc.iceGatheringStateChange.subscribe((state) => {
      if (state === "complete") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

function normalizeStreamKey(raw) {
  if (raw == null) return "";
  let key = String(raw).trim();
  key = key.replace(/[\uFEFF\u200B-\u200D]/g, "");
  while (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }
  while (/^Bearer\s+/i.test(key)) key = key.replace(/^Bearer\s+/i, "").trim();
  key = key.replace(/\s+/g, "");
  const urlMatch = key.match(/\/whip\/([A-Za-z0-9_-]{12,128})\/?$/);
  if (urlMatch) key = urlMatch[1];
  return key;
}

function validateStreamKey(streamKey) {
  const key = normalizeStreamKey(streamKey);
  if (!key) return false;
  if (key.length < 12 || key.length > 128) return false;
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) return false;
  if (STATIC_KEYS.has(key)) return true;
  if (registeredKeys.has(key)) return true;
  return false;
}

/** OBS: Authorization: Bearer <stream-key> (any casing / extra spaces). */
function parseBearerToken(req) {
  const raw = String(req.get?.("authorization") ?? req.headers?.authorization ?? "").trim();
  if (!raw) return null;
  let token = raw;
  while (/^Bearer\s+/i.test(token)) token = token.replace(/^Bearer\s+/i, "").trim();
  token = normalizeStreamKey(token);
  return token || null;
}

function resolveStreamKey(req, pathKey) {
  const candidates = [];
  if (typeof pathKey === "string" && pathKey.trim()) candidates.push(pathKey);
  const bearer = parseBearerToken(req);
  if (bearer) candidates.push(bearer);
  for (const candidate of candidates) {
    const key = normalizeStreamKey(candidate);
    if (key && validateStreamKey(key)) return key;
  }
  return null;
}

function normalizeOfferSdp(sdp) {
  const text = String(sdp || "").trim();
  if (!text) return text;
  const normalized = text.replace(/\r?\n/g, "\r\n");
  return normalized.endsWith("\r\n") ? normalized : `${normalized}\r\n`;
}

/** Text-only OBS/WHIP SDP cleanup before setRemoteDescription (no PeerConnection calls). */
function sanitizeWhipOfferSdp(rawSdp) {
  const lines = normalizeOfferSdp(rawSdp)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

  const mids = new Set();
  const cleaned = [];

  for (const line of lines) {
    if (line === "a=extmap-allow-mixed") continue;
    // Keep a=ssrc / a=ssrc-group — OBS WHIP needs them for RTP demux in werift.
    if (/^a=rtcp:\d+ IN IP4 0\.0\.0\.0$/.test(line)) continue;
    if (line.startsWith("a=mid:")) mids.add(line.slice("a=mid:".length));
    cleaned.push(line);
  }

  for (let i = 0; i < cleaned.length; i++) {
    if (!cleaned[i].startsWith("a=group:BUNDLE ")) continue;
    const bundleMids = cleaned[i].slice("a=group:BUNDLE ".length).split(/\s+/).filter(Boolean);
    const validMids = bundleMids.filter((mid) => mids.has(mid));
    if (validMids.length > 0) {
      cleaned[i] = `a=group:BUNDLE ${validMids.join(" ")}`;
    }
  }

  return normalizeOfferSdp(cleaned.join("\n"));
}

function parseOfferMediaCodecs(sdp) {
  const lines = sdp.replace(/\r\n/g, "\n").split("\n");
  /** @type {{ kind: string, payloadTypes: string[], rtpmaps: Record<string, string>, fmtps: Record<string, string> }[]} */
  const sections = [];
  let section = null;

  for (const line of lines) {
    if (line.startsWith("m=")) {
      section = {
        kind: line.split(/\s+/)[0].slice(2),
        payloadTypes: line.split(/\s+/).slice(3),
        rtpmaps: {},
        fmtps: {},
      };
      sections.push(section);
      continue;
    }
    if (!section) continue;
    const rtpmap = line.match(/^a=rtpmap:(\d+)\s+(.+)$/);
    if (rtpmap) {
      section.rtpmaps[rtpmap[1]] = rtpmap[2];
      continue;
    }
    const fmtp = line.match(/^a=fmtp:(\d+)\s+(.+)$/);
    if (fmtp) section.fmtps[fmtp[1]] = fmtp[2];
  }

  return sections;
}

function buildWeriftPeerConfig(offerSdp) {
  const sections = parseOfferMediaCodecs(offerSdp);
  const audioSection = sections.find((section) => section.kind === "audio");
  const videoSection = sections.find((section) => section.kind === "video");

  const audioCodecs = [];
  if (audioSection) {
    for (const payloadType of audioSection.payloadTypes) {
      const mime = (audioSection.rtpmaps[payloadType] || "").toLowerCase();
      if (!mime.startsWith("opus/")) continue;
      const parts = mime.split("/");
      audioCodecs.push(
        useOPUS({
          payloadType: Number(payloadType),
          clockRate: Number(parts[1]) || 48000,
          channels: Number(parts[2]) || 2,
        })
      );
    }
  }
  if (audioCodecs.length === 0) {
    audioCodecs.push(useOPUS({ clockRate: 48000, channels: 2 }));
  }

  const videoCodecs = [];
  if (videoSection) {
    for (const payloadType of videoSection.payloadTypes) {
      const mime = (videoSection.rtpmaps[payloadType] || "").toLowerCase();
      const fmtp = videoSection.fmtps[payloadType];
      const pt = Number(payloadType);
      if (mime.startsWith("h264/")) {
        videoCodecs.push(useH264({ payloadType: pt, sdpFmtpLine: fmtp }));
      } else if (mime.startsWith("vp8/")) {
        videoCodecs.push(useVP8({ payloadType: pt }));
      } else if (mime.startsWith("vp9/")) {
        videoCodecs.push(useVP9({ payloadType: pt }));
      } else if (mime.startsWith("av1/")) {
        videoCodecs.push(useAV1X({ payloadType: pt }));
      }
    }
  }
  if (videoCodecs.length === 0) {
    videoCodecs.push(useH264());
  }

  return {
    codecs: { audio: audioCodecs, video: videoCodecs },
    headerExtensions: { video: [useSdesRTPStreamId()] },
    iceServers: ICE_SERVERS,
  };
}

function createWeriftPeerConnection(peerConfig) {
  return new RTCPeerConnection(peerConfig);
}

/** Attach WHIP ingest tracks to a WHEP playback peer (browser recvonly offer already applied). */
function attachWhipTracksToWhepPc(whepPc, whipSession) {
  const byKind = getLiveWhipRelayTracks(whipSession);

  for (const kind of ["audio", "video"]) {
    const track = byKind.get(kind);
    if (!track) continue;
    const transceiver = whepPc.getTransceivers().find((tx) => tx.kind === kind);
    if (!transceiver?.sender) {
      console.warn(`[WHEP] no transceiver for ${kind}`);
      continue;
    }
    transceiver.sender.registerTrack(track);
    if (transceiver.direction !== "sendonly" && transceiver.direction !== "sendrecv") {
      transceiver.setDirection("sendonly");
    }
    console.log(
      `[WHEP] relay ${kind} id=${trackId(track) ?? "?"} transceiver=yes dir=${transceiver.direction}/${transceiver.currentDirection ?? "-"}`
    );
  }
}

function rebindWhepRelay(whipSession) {
  const tracks = getIngestRelayTracks(whipSession);
  if (!tracks.some((t) => t.kind === "video")) return;
  for (const whepId of [...whipSession.whepResourceIds]) {
    const whep = whepSessions.get(whepId);
    if (!whep?.pc || whep.pc.connectionState === "closed") {
      whipSession.whepResourceIds.delete(whepId);
      closeWhepSession(whepId);
      continue;
    }
    attachWhipTracksToWhepPc(whep.pc, whipSession);
    console.log(`[WHEP] rebound key=${whipSession.streamKey} resource=${whepId}`);
  }
}

function requestBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const host = req.get("host");
  if (!host) return PUBLIC_BASE_URL;
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  return `${proto}://${host}`.replace(/\/$/, "");
}

function getBroadcastUrls(streamKey, baseUrl = PUBLIC_BASE_URL) {
  const origin = baseUrl.replace(/\/$/, "");
  return {
    streamKey,
    whipServerUrl: `${origin}/whip`,
    whipBearerToken: streamKey,
    whipUrl: `${origin}/whip/${streamKey}`,
    whepUrl: `${origin}/whep/${streamKey}`,
    statusUrl: `${origin}/api/broadcast/${streamKey}/status`,
  };
}

const WHIP_ICE_LINK =
  '<stun:stun.l.google.com:19302>; rel="ice-server", ' +
  '<turn:openrelay.metered.ca:3478?transport=udp>; rel="ice-server"; username="openrelayproject"; credential="openrelayproject", ' +
  '<turn:openrelay.metered.ca:3478?transport=tcp>; rel="ice-server"; username="openrelayproject"; credential="openrelayproject"';

function sendWhipOptions(_req, res) {
  res.set("Accept-Post", "application/sdp");
  res.status(204).end();
}

function rejectStreamKey(req, res, reason) {
  const bearer = parseBearerToken(req);
  const pathKey = normalizeStreamKey(req.params?.streamKey);
  console.log(
    `[WHIP] 401 ${reason} path=${req.path} bearerLen=${bearer?.length ?? 0} ` +
      `bearerKnown=${bearer ? validateStreamKey(bearer) : false} pathKeyKnown=${pathKey ? validateStreamKey(pathKey) : false} ` +
      `registered=${registeredKeys.size} authHeader=${req.get?.("authorization") ? "yes" : "no"}`
  );
  return res.status(401).type("text/plain").send("Unauthorized: invalid stream key");
}

function makeStreamKey() {
  return `tc-${randomBytes(18).toString("base64url")}`;
}

function closeWhipSession(streamKey, { closeWhep = true } = {}) {
  const session = whipSessions.get(streamKey);
  if (!session) return;
  if (closeWhep) {
    for (const whepId of session.whepResourceIds) closeWhepSession(whepId);
  }
  try {
    session.whipReceiver?.close?.();
  } catch (_) {
    /* ignore */
  }
  try {
    session.pc?.close?.();
  } catch (_) {
    /* ignore */
  }
  whipSessions.delete(streamKey);
}

function closeWhepSession(resourceId) {
  const session = whepSessions.get(resourceId);
  if (!session) return;
  try {
    session.pc?.close?.();
  } catch (_) {
    /* ignore */
  }
  whepSessions.delete(resourceId);
}

const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "https://tangent-club.com",
  "https://www.tangent-club.com",
]);

initDb();

const app = express();
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.has(origin)) return callback(null, true);
      if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept", "If-Match"],
    exposedHeaders: ["Location", "ETag", "Link"],
  })
);
app.use(express.json({ limit: "32kb" }));
app.use(express.text({ type: ["application/sdp", "text/plain", "*/*"], limit: "256kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "tangent-club-whip", sessions: whipSessions.size });
});

app.use("/api", authRouter);

app.post("/api/broadcast/register", (req, res) => {
  const peerId = typeof req.body?.peerId === "string" ? req.body.peerId.trim() : "";
  const streamKey = makeStreamKey();
  registeredKeys.set(streamKey, { peerId, createdAt: Date.now() });
  const baseUrl = requestBaseUrl(req);
  res.status(201).json({
    ...getBroadcastUrls(streamKey, baseUrl),
    peerId: peerId || null,
    message:
      "OBS: Server = whipServerUrl, Bearer Token = whipBearerToken. Re-register after server restart.",
  });
});

app.get("/api/broadcast/:streamKey/status", (req, res) => {
  const { streamKey } = req.params;
  if (!validateStreamKey(streamKey)) {
    return res.status(401).json({ ok: false, error: "invalid_stream_key" });
  }
  const session = whipSessions.get(streamKey);
  const tracks = session ? getIngestRelayTracks(session) : [];
  const videoTracks = tracks.filter((t) => t.kind === "video");
  const videoRtp = !!session?.rtpSeen?.video;
  res.json({
    ok: true,
    streamKey,
    whipIngest: !!session,
    connectionState: session?.pc?.connectionState || null,
    live: videoRtp,
    videoRtp,
    tracksReady: videoTracks.length > 0,
    videoTracks: videoTracks.length,
    audioTracks: tracks.filter((t) => t.kind === "audio").length,
    trackCount: tracks.length,
    whepSubscribers: session?.whepResourceIds?.size || 0,
    updatedAt: session?.updatedAt || null,
  });
});

app.options("/whip", sendWhipOptions);
app.options("/whip/", sendWhipOptions);
app.options("/whip/:streamKey", sendWhipOptions);

async function handleWhipIngest(req, res, streamKey) {
  const offerSdp = sanitizeWhipOfferSdp((req.body || "").trim());
  const baseUrl = requestBaseUrl(req);

  console.log(`[WHIP] ingest key=${streamKey} bytes=${offerSdp.length} auth=${parseBearerToken(req) ? "yes" : "no"}`);

  if (!offerSdp.includes("v=0")) {
    return res.status(400).type("text/plain").send("Bad Request: SDP offer required");
  }

  const priorSession = whipSessions.get(streamKey);
  const priorWhepIds = new Set(priorSession?.whepResourceIds || []);
  closeWhipSession(streamKey, { closeWhep: false });

  const resourceId = randomBytes(12).toString("hex");
  const peerConfig = buildWeriftPeerConfig(offerSdp);
  const pc = createWeriftPeerConnection(peerConfig);
  const whipReceiver = new WhipReceiver(pc);
  const tracks = [];

  const session = {
    streamKey,
    resourceId,
    pc,
    whipReceiver,
    peerConfig,
    tracks,
    ingestTracks: { audio: null, video: null },
    live: false,
    rtpSeen: { audio: false, video: false },
    whepResourceIds: priorWhepIds,
    updatedAt: Date.now(),
  };

  bindWhipTrackHandler(session);
  bindWhipTransceiverHandlers(session);

  pc.connectionStateChange.subscribe(() => {
    if (whipSessions.get(streamKey) !== session) return;
    session.updatedAt = Date.now();
    console.log(`[WHIP] connectionState=${pc.connectionState} key=${streamKey} tracks=${tracks.length}`);
    if (pc.connectionState === "connected") {
      harvestIngestTracks(session, { log: false });
      bindAllTransceiverRtp(session);
      logWhipTransceivers(session);
      startIngestTrackPoll(session);
      session.live = !!session.rtpSeen?.video;
      rebindWhepRelay(session);
    }
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      closeWhipSession(streamKey);
    }
  });

  try {
    await whipReceiver.setRemoteOffer(offerSdp);
    harvestIngestTracks(session, { log: true });
    await waitWeriftIceGathering(pc, 8000);

    whipSessions.set(streamKey, session);

    const answerSdp = normalizeOfferSdp(pc.localDescription?.sdp || "");
    const location = `${baseUrl}/whip/${streamKey}/${resourceId}`;
    res.set("Location", location);
    res.set("ETag", `"${whipReceiver.etag}"`);
    res.set("Link", WHIP_ICE_LINK);
    res.set("Content-Type", "application/sdp");
    res.set("Access-Control-Expose-Headers", "Location, ETag, Link");
    console.log(`[WHIP] 201 answer key=${streamKey} resource=${resourceId} tracks=${tracks.length}`);
    return res.status(201).send(answerSdp);
  } catch (err) {
    closeWhipSession(streamKey);
    console.error("[WHIP] ingest failed:", err);
    return res.status(500).type("text/plain").send(`WHIP error: ${err.message || err}`);
  }
}

app.post("/whip", async (req, res) => {
  const streamKey = resolveStreamKey(req, null);
  if (!streamKey) return rejectStreamKey(req, res, "missing bearer token on POST /whip");
  return handleWhipIngest(req, res, streamKey);
});

app.post("/whip/", async (req, res) => {
  const streamKey = resolveStreamKey(req, null);
  if (!streamKey) return rejectStreamKey(req, res, "missing bearer token on POST /whip/");
  return handleWhipIngest(req, res, streamKey);
});

app.post("/whip/:streamKey", async (req, res) => {
  const streamKey = resolveStreamKey(req, req.params.streamKey);
  if (!streamKey) return rejectStreamKey(req, res, "invalid path or bearer token");
  return handleWhipIngest(req, res, streamKey);
});

app.patch("/whip/:streamKey/:resourceId", async (req, res) => {
  const { streamKey, resourceId } = req.params;
  const session = whipSessions.get(streamKey);
  if (!session || session.resourceId !== resourceId) {
    return res.status(404).type("text/plain").send("Not found");
  }
  const candidateSdp = String(req.body || "").trim();
  if (!candidateSdp) {
    return res.status(400).type("text/plain").send("Bad Request: ICE fragment required");
  }
  try {
    await session.whipReceiver.iceRequest({
      etag: String(req.get("If-Match") || "").replace(/^"|"$/g, ""),
      candidate: candidateSdp,
    });
    harvestIngestTracks(session);
    return res.status(204).end();
  } catch (err) {
    console.error("[WHIP] trickle ICE failed:", err);
    return res.status(500).type("text/plain").send(`WHIP ICE error: ${err.message || err}`);
  }
});

app.delete("/whip/:streamKey/:resourceId", (req, res) => {
  const { streamKey, resourceId } = req.params;
  const session = whipSessions.get(streamKey);
  if (!session || session.resourceId !== resourceId) {
    return res.status(404).type("text/plain").send("Not found");
  }
  for (const whepId of session.whepResourceIds) closeWhepSession(whepId);
  closeWhipSession(streamKey);
  return res.status(200).type("text/plain").send("OK");
});

app.post("/whep/:streamKey", async (req, res) => {
  const { streamKey } = req.params;
  const offerSdp = sanitizeWhipOfferSdp((req.body || "").trim());

  console.log(`[WHEP] playback request key=${streamKey}`);

  if (!validateStreamKey(streamKey)) {
    return res.status(401).type("text/plain").send("Unauthorized: invalid stream key");
  }
  if (!offerSdp.includes("v=0")) {
    return res.status(400).type("text/plain").send("Bad Request: SDP offer required");
  }

  const whip = whipSessions.get(streamKey);
  if (!whip) {
    return res.status(404).type("text/plain").send("No active WHIP stream for this key");
  }

  let liveTracks;
  try {
    liveTracks = await waitForWhipTracks(whip, 12000);
  } catch (_) {
    return res.status(404).type("text/plain").send("WHIP connected but no media tracks yet — retry in OBS");
  }

  if (!liveTracks.some((t) => t.kind === "video")) {
    return res.status(404).type("text/plain").send("No video track on WHIP stream yet");
  }

  try {
    await waitForWhipVideoRtp(whip, 15000);
  } catch (_) {
    return res
      .status(404)
      .type("text/plain")
      .send("WHIP connected but no video data from OBS yet — check OBS is streaming");
  }

  const resourceId = randomBytes(12).toString("hex");
  const pc = createWeriftPeerConnection(whip.peerConfig || buildWeriftPeerConfig(offerSdp));

  try {
    await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    attachWhipTracksToWhepPc(pc, whip);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitWeriftIceGathering(pc, 8000);
    attachWhipTracksToWhepPc(pc, whip);

    whepSessions.set(resourceId, { streamKey, resourceId, pc });
    whip.whepResourceIds.add(resourceId);

    const location = `${requestBaseUrl(req)}/whep/${streamKey}/${resourceId}`;
    res.set("Location", location);
    res.set("Content-Type", "application/sdp");
    res.set("Access-Control-Expose-Headers", "Location");
    const relayCount = pc.getSenders().filter((s) => s.track).length;
    console.log(
      `[WHEP] answer sent key=${streamKey} active=${liveTracks.length} relay=${relayCount} sessionTracks=${whip.tracks.length}`
    );
    const answerSdp = normalizeOfferSdp(pc.localDescription?.sdp || answer.sdp || "");
    return res.status(201).send(answerSdp);
  } catch (err) {
    closeWhepSession(resourceId);
    console.error("[WHEP] playback failed:", err);
    return res.status(500).type("text/plain").send(`WHEP error: ${err.message || err}`);
  }
});

app.delete("/whep/:streamKey/:resourceId", (req, res) => {
  const { streamKey, resourceId } = req.params;
  const session = whepSessions.get(resourceId);
  if (!session || session.streamKey !== streamKey) {
    return res.status(404).type("text/plain").send("Not found");
  }
  const whip = whipSessions.get(streamKey);
  whip?.whepResourceIds?.delete(resourceId);
  closeWhepSession(resourceId);
  return res.status(200).type("text/plain").send("OK");
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(WEB_ROOT, "index.html"));
});
app.use(express.static(WEB_ROOT, { index: false, maxAge: 0 }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`WHIP/WHEP server v16 (keep SSRC + live relay) on ${PUBLIC_BASE_URL}`);
  console.log(`  App (local):  ${PUBLIC_BASE_URL}/  or  http://127.0.0.1:${PORT}/`);
  console.log(`  Live Server:  http://127.0.0.1:5500/ also works (API on :${PORT})`);
  console.log(`  WHIP ingest:  POST ${PUBLIC_BASE_URL}/whip/:stream_key`);
  console.log(`  WHEP playback: POST ${PUBLIC_BASE_URL}/whep/:stream_key`);
  console.log(`  Register key: POST ${PUBLIC_BASE_URL}/api/broadcast/register`);
});
