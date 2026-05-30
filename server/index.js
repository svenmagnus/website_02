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
import wrtc from "@roamhq/wrtc";

const { RTCPeerConnection, RTCSessionDescription } = wrtc;

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

function getBroadcastUrls(streamKey) {
  return {
    streamKey,
    whipUrl: `${PUBLIC_BASE_URL}/whip/${streamKey}`,
    whepUrl: `${PUBLIC_BASE_URL}/whep/${streamKey}`,
    statusUrl: `${PUBLIC_BASE_URL}/api/broadcast/${streamKey}/status`,
  };
}

const app = express();
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
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
  res.status(201).json({
    ...getBroadcastUrls(streamKey),
    peerId: peerId || null,
    message: "Paste the WHIP URL into OBS (WHIP service). Stream key is part of the URL path.",
  });
});

app.get("/api/broadcast/:streamKey/status", (req, res) => {
  const { streamKey } = req.params;
  if (!validateStreamKey(streamKey)) {
    return res.status(401).json({ ok: false, error: "invalid_stream_key" });
  }
  const session = whipSessions.get(streamKey);
  const tracks = session?.tracks?.filter((t) => t.readyState === "live") || [];
  res.json({
    ok: true,
    streamKey,
    live: !!(session && session.live && tracks.length > 0),
    videoTracks: tracks.filter((t) => t.kind === "video").length,
    audioTracks: tracks.filter((t) => t.kind === "audio").length,
    whepSubscribers: session?.whepResourceIds?.size || 0,
    updatedAt: session?.updatedAt || null,
  });
});

app.post("/whip/:streamKey", async (req, res) => {
  const { streamKey } = req.params;
  const offerSdp = (req.body || "").trim();

  if (!validateStreamKey(streamKey)) {
    return res.status(401).type("text/plain").send("Unauthorized: invalid stream key");
  }
  if (!offerSdp.includes("v=0")) {
    return res.status(400).type("text/plain").send("Bad Request: SDP offer required");
  }

  closeWhipSession(streamKey);

  const resourceId = randomBytes(12).toString("hex");
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  /** @type {import('wrtc').MediaStreamTrack[]} */
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

  pc.ontrack = (event) => {
    if (event.track) {
      tracks.push(event.track);
      session.updatedAt = Date.now();
      session.live = tracks.some((t) => t.readyState === "live");
    }
  };

  pc.onconnectionstatechange = () => {
    session.updatedAt = Date.now();
    if (pc.connectionState === "connected") {
      session.live = tracks.length > 0;
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
    await waitIceGatheringComplete(pc);

    whipSessions.set(streamKey, session);

    const location = `${PUBLIC_BASE_URL}/whip/${streamKey}/${resourceId}`;
    res.set("Location", location);
    res.set("Content-Type", "application/sdp");
    res.set("Access-Control-Expose-Headers", "Location");
    return res.status(201).send(pc.localDescription.sdp);
  } catch (err) {
    closeWhipSession(streamKey);
    console.error("[WHIP] ingest failed:", err);
    return res.status(500).type("text/plain").send(`WHIP error: ${err.message || err}`);
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
  const offerSdp = (req.body || "").trim();

  if (!validateStreamKey(streamKey)) {
    return res.status(401).type("text/plain").send("Unauthorized: invalid stream key");
  }
  if (!offerSdp.includes("v=0")) {
    return res.status(400).type("text/plain").send("Bad Request: SDP offer required");
  }

  const whip = whipSessions.get(streamKey);
  const liveTracks = whip?.tracks?.filter((t) => t.readyState === "live") || [];
  if (!whip || liveTracks.length === 0) {
    return res.status(404).type("text/plain").send("No active WHIP stream for this key");
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

    const location = `${PUBLIC_BASE_URL}/whep/${streamKey}/${resourceId}`;
    res.set("Location", location);
    res.set("Content-Type", "application/sdp");
    res.set("Access-Control-Expose-Headers", "Location");
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

app.listen(PORT, () => {
  console.log(`WHIP/WHEP server listening on ${PUBLIC_BASE_URL}`);
  console.log(`  WHIP ingest:  POST ${PUBLIC_BASE_URL}/whip/:stream_key`);
  console.log(`  WHEP playback: POST ${PUBLIC_BASE_URL}/whep/:stream_key`);
  console.log(`  Register key: POST ${PUBLIC_BASE_URL}/api/broadcast/register`);
});
