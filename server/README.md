# WHIP / WHEP Server (OBS → Dual-Peer)

Node.js bridge so **OBS Studio** can push your full scene via **WHIP**, while the host browser pulls it via **WHEP** and forwards it to the guest over **PeerJS** (existing P2P path).

## npm packages

```bash
cd server
npm install
```

| Package | Purpose |
|---------|---------|
| `express` | HTTP server |
| `cors` | Browser calls from tangent-club.com / localhost |
| `@roamhq/wrtc` | WebRTC (WHIP ingest + WHEP playback) in Node |

No separate `whip-wrtc` package required — WHIP/WHEP are thin SDP-over-HTTP handlers on top of `RTCPeerConnection`.

## Start server

```bash
cp .env.example .env   # optional
npm start
```

Default: `http://localhost:8787`

**Important for local testing:** open the app at **`http://127.0.0.1:8787/`** (same server serves the website + WHIP API).  
Do **not** use `https://tangent-club.com` with a localhost WHIP server — the browser blocks that.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/broadcast/register` | Creates stream key + URLs (host UI) |
| `GET` | `/api/broadcast/:stream_key/status` | Is OBS streaming? |
| `POST` | `/whip/:stream_key` | **WHIP ingest** — OBS sends SDP offer |
| `DELETE` | `/whip/:stream_key/:resourceId` | Stop ingest |
| `POST` | `/whep/:stream_key` | **WHEP playback** — host browser receives stream |
| `GET` | `/health` | Health check |

### Stream key validation (placeholder)

- Keys from `POST /api/broadcast/register` are valid for the lifetime of the server process.
- Static keys from env `STREAM_KEYS` (comma-separated).
- Replace `validateStreamKey()` in `index.js` with your DB lookup later.

## OBS Studio setup (OBS 30+)

1. In the web app: **Broadcast → OBS Studio (WHIP)** → **Start as Host**
2. Copy the **WHIP URL** shown (e.g. `http://localhost:8787/whip/tc-…`)
3. In OBS: **Settings → Stream**
   - Service: **WHIP**
   - Server / URL: paste the full WHIP URL
4. Click **Start Streaming** in OBS
5. The host panel shows your **live scene** (not the Virtual Camera logo)
6. Guest connects with Peer ID as usual

## Production (Option A — Cloudflare quick tunnel)

See **[docs/CLOUDFLARE-TUNNEL.md](../docs/CLOUDFLARE-TUNNEL.md)** for the full workflow.

1. `cd server && npm run restart` and `npm run tunnel`
2. Paste the `https://….trycloudflare.com` URL into `assets/app.js` → `WHIP_CLOUDFLARE_TUNNEL_URL`
3. Push to GitHub; open **https://www.tangent-club.com**
4. OBS uses the HTTPS tunnel URL + Bearer Token from the host panel

## Production (Option B — fixed subdomain)

1. Deploy this server (VPS, Fly.io, Railway, etc.) with HTTPS
2. Set `PUBLIC_BASE_URL=https://whip.tangent-club.com` in server `.env`
3. Point DNS `whip.tangent-club.com` at the server
4. Set `WHIP_CLOUDFLARE_TUNNEL_URL` to that HTTPS origin (or use a dedicated production constant)
5. Add TURN credentials for production (same as `assets/app.js`)

## Architecture

```
OBS --WHIP--> Node server --WHEP--> Host browser --PeerJS--> Guest
```

Video is ingested once; the guest still receives it over your existing PeerJS mesh from the host tab.
