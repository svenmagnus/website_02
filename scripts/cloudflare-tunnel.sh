#!/usr/bin/env bash
# Expose local WHIP server (port 8787) via Cloudflare quick tunnel.
# Requires: brew install cloudflared  (or https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
set -euo pipefail

PORT="${WHIP_PORT:-8787}"
ORIGIN="http://127.0.0.1:${PORT}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found. Install: brew install cloudflared"
  exit 1
fi

if ! lsof -i ":${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "No server on port ${PORT}. Start first: cd server && npm run restart"
  exit 1
fi

echo "Starting Cloudflare tunnel → ${ORIGIN}"
echo ""
echo "When you see  https://….trycloudflare.com"
echo "  1. Copy that URL (no trailing slash)"
echo "  2. Paste into assets/app.js → WHIP_CLOUDFLARE_TUNNEL_URL"
echo "  3. Optional: server/.env → PUBLIC_BASE_URL=<same URL>"
echo "  4. git commit + push → test https://www.tangent-club.com"
echo "  5. OBS WHIP server = <tunnel-url>/whip"
echo ""
exec cloudflared tunnel --url "${ORIGIN}"
