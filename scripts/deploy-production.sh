#!/usr/bin/env bash
# Deploy to Hetzner VPS (after git push origin main).
# Uses SSH key — password login is disabled on the server.
set -euo pipefail

KEY="${HETZNER_SSH_KEY:-$HOME/.ssh/id_ed25519_hetzner}"
HOST="${HETZNER_HOST:-root@167.233.30.166}"

if [[ ! -f "$KEY" ]]; then
  echo "SSH key not found: $KEY"
  echo "See docs/DEPLOY-HETZNER.md"
  exit 1
fi

echo "==> Deploying to $HOST"
ssh -i "$KEY" "$HOST" bash -s <<'REMOTE'
set -euo pipefail
cd /home/tangent/website_02
sudo -u tangent git pull
chown -R tangent:tangent /home/tangent/website_02
cd server && sudo -u tangent npm install --omit=dev
systemctl restart tangent-club
systemctl is-active tangent-club
# Nginx default body limit is 1 MB — gallery uploads need more headroom.
NGINX_SITE="/etc/nginx/sites-available/tangent-club"
if [[ -f "$NGINX_SITE" ]] && ! grep -q 'client_max_body_size' "$NGINX_SITE"; then
  sed -i '/location \/ {/a\        client_max_body_size 6m;' "$NGINX_SITE"
  nginx -t
  systemctl reload nginx
  echo "nginx: added client_max_body_size 6m"
fi
git -C /home/tangent/website_02 log -1 --oneline
REMOTE
echo "==> Done. Hard-refresh tangent-club.com in the browser."
