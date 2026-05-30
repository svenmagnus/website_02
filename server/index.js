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
import wrtc from "@roamhq/wrtc";

const { RTCPeerConnection, RTCSessionDescription } = wrtc;

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

function waitForWhipTracks(session, timeoutMs = 10000) {
  if (session.tracks.length > 0) return Promise.resolve(session.tracks);
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (session.tracks.length > 0) return resolve(session.tracks);
      if (Date.now() >= deadline) {
        return reject(new Error("WHIP tracks not received in time"));
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

function bindWhipTrackHandler(session, tracks) {
  const onTrack = (event) => {
    if (!event.track) return;
    if (!tracks.includes(event.track)) tracks.push(event.track);
    session.updatedAt = Date.now();
    session.live = tracks.some((t) => t.kind === "video" && t.readyState !== "ended");
    console.log(
      `[WHIP] track ${event.track.kind} id=${event.track.id} readyState=${event.track.readyState} key=${session.streamKey}`
    );
  };
  session.pc.addEventListener("track", onTrack);
  session.pc.ontrack = onTrack;
}

function waitIceGatheringComplete(pc, timeoutMs = 4000) {
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

function validateStreamKey(streamKey) {
  if (!streamKey || typeof streamKey !== "string") return false;
  if (streamKey.length < 12 || streamKey.length > 128) return false;
  if (!/^[a-zA-Z0-9_-]+$/.test(streamKey)) return false;
  if (STATIC_KEYS.has(streamKey)) return true;
  if (registeredKeys.has(streamKey)) return true;
  return false;
}

/** OBS sends stream key as Bearer token; path key is optional. */
function parseBearerToken(req) {
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  let token = match[1].trim();
  if (token.toLowerCase().startsWith("bearer ")) token = token.slice(7).trim();
  return token || null;
}

function resolveStreamKey(req, pathKey) {
  const fromPath = typeof pathKey === "string" ? pathKey.trim() : "";
  if (fromPath && validateStreamKey(fromPath)) return fromPath;
  const bearer = parseBearerToken(req);
  if (bearer && validateStreamKey(bearer)) return bearer;
  return null;
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
  console.log(
    `[WHIP] 401 ${reason} path=${req.path} auth=${req.headers.authorization ? "Bearer …" : "none"}`
  );
  return res.status(401).type("text/plain").send("Unauthorized: invalid stream key");
}

function makeStreamKey() {
  return `tc-${randomBytes(18).toString("base64url")}`;
}

function closeWhipSession(streamKey) {
  const session = whipSessions.get(streamKey);
  if (!session) return;
  try {
    session.pc.close();
  } catch (_) {
    /* ignore */
  }
  whipSessions.delete(streamKey);
}

function closeWhepSession(resourceId) {
  const session = whepSessions.get(resourceId);
  if (!session) return;
  try {
    session.pc.close();
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
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
    exposedHeaders: ["Location"],
  })
);
app.use(express.json({ limit: "32kb" }));
app.use(express.text({ type: ["application/sdp", "text/plain", "*/*"], limit: "256kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "tangent-club-whip", sessions: whipSessions.size });
});

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
  const tracks = session?.tracks || [];
  const videoTracks = tracks.filter((t) => t.kind === "video" && t.readyState !== "ended");
  res.json({
    ok: true,
    streamKey,
    whipIngest: !!session,
    connectionState: session?.pc?.connectionState || null,
    live: videoTracks.length > 0,
    videoTracks: videoTracks.length,
    audioTracks: tracks.filter((t) => t.kind === "audio" && t.readyState !== "ended").length,
    trackCount: tracks.length,
    whepSubscribers: session?.whepResourceIds?.size || 0,
    updatedAt: session?.updatedAt || null,
  });
});

app.options("/whip", sendWhipOptions);
app.options("/whip/", sendWhipOptions);
app.options("/whip/:streamKey", sendWhipOptions);

async function handleWhipIngest(req, res, streamKey) {
  const offerSdp = (req.body || "").trim();
  const baseUrl = requestBaseUrl(req);

  console.log(`[WHIP] ingest key=${streamKey} bytes=${offerSdp.length} auth=${parseBearerToken(req) ? "yes" : "no"}`);

  if (!offerSdp.includes("v=0")) {
    return res.status(400).type("text/plain").send("Bad Request: SDP offer required");
  }

  closeWhipSession(streamKey);

  const resourceId = randomBytes(12).toString("hex");
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const tracks = [];

  const session = {
    streamKey,
    resourceId,
    pc,
    tracks,
    live: false,
    whepResourceIds: new Set(),
    updatedAt: Date.now(),
  };

  bindWhipTrackHandler(session, tracks);

  pc.onconnectionstatechange = () => {
    session.updatedAt = Date.now();
    console.log(`[WHIP] connectionState=${pc.connectionState} key=${streamKey} tracks=${tracks.length}`);
    if (pc.connectionState === "connected") {
      session.live = tracks.some((t) => t.kind === "video" && t.readyState !== "ended");
    }
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      closeWhipSession(streamKey);
      for (const whepId of session.whepResourceIds) closeWhepSession(whepId);
    }
  };

  try {
    await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: offerSdp }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceGatheringComplete(pc, 8000);

    whipSessions.set(streamKey, session);

    const location = `${baseUrl}/whip/${streamKey}/${resourceId}`;
    res.set("Location", location);
    res.set("Link", WHIP_ICE_LINK);
    res.set("Content-Type", "application/sdp");
    res.set("Access-Control-Expose-Headers", "Location, Link");
    console.log(`[WHIP] 201 answer key=${streamKey} resource=${resourceId}`);
    return res.status(201).send(pc.localDescription.sdp);
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
  const offerSdp = (req.body || "").trim();

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
    liveTracks = (await waitForWhipTracks(whip, 12000)).filter((t) => t.readyState !== "ended");
  } catch (_) {
    return res.status(404).type("text/plain").send("WHIP connected but no media tracks yet — retry in OBS");
  }

  if (!liveTracks.some((t) => t.kind === "video")) {
    return res.status(404).type("text/plain").send("No video track on WHIP stream yet");
  }

  const resourceId = randomBytes(12).toString("hex");
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  for (const track of liveTracks) {
    pc.addTrack(track);
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: offerSdp }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceGatheringComplete(pc);

    whepSessions.set(resourceId, { streamKey, resourceId, pc });
    whip.whepResourceIds.add(resourceId);

    const location = `${requestBaseUrl(req)}/whep/${streamKey}/${resourceId}`;
    res.set("Location", location);
    res.set("Content-Type", "application/sdp");
    res.set("Access-Control-Expose-Headers", "Location");
    console.log(`[WHEP] answer sent key=${streamKey} tracks=${liveTracks.length}`);
    return res.status(201).send(pc.localDescription.sdp);
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
  console.log(`WHIP/WHEP server v2 (static app + CORS) on ${PUBLIC_BASE_URL}`);
  console.log(`  App (local):  ${PUBLIC_BASE_URL}/  or  http://127.0.0.1:${PORT}/`);
  console.log(`  Live Server:  http://127.0.0.1:5500/ also works (API on :${PORT})`);
  console.log(`  WHIP ingest:  POST ${PUBLIC_BASE_URL}/whip/:stream_key`);
  console.log(`  WHEP playback: POST ${PUBLIC_BASE_URL}/whep/:stream_key`);
  console.log(`  Register key: POST ${PUBLIC_BASE_URL}/api/broadcast/register`);
});
