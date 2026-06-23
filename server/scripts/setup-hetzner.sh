#!/bin/bash
# Tangent Club — first-time setup on Ubuntu (Hetzner).
# Run as root on the server: bash scripts/setup-hetzner.sh
set -euo pipefail

APP_USER="${APP_USER:-tangent}"
APP_DIR="/home/${APP_USER}/website_02"
REPO="${REPO:-https://github.com/svenmagnus/website_02.git}"

echo "==> System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq git nginx certbot python3-certbot-nginx ufw curl build-essential

if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 -s | tr -d v)" -lt 20 ]]; then
  echo "==> Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

echo "==> Firewall"
ufw allow OpenSSH
ufw allow 'Nginx Full'
# WebRTC media (WHIP/WHEP) — must match WEBRTC_UDP_PORT_MIN/MAX in server/.env
ufw allow 10000:60000/udp
ufw --force enable

if ! id "$APP_USER" &>/dev/null; then
  echo "==> User ${APP_USER}"
  adduser --disabled-password --gecos "" "$APP_USER"
  usermod -aG sudo "$APP_USER"
  mkdir -p "/home/${APP_USER}/.ssh"
  if [[ -f /root/.ssh/authorized_keys ]]; then
    cp /root/.ssh/authorized_keys "/home/${APP_USER}/.ssh/"
    chown -R "${APP_USER}:${APP_USER}" "/home/${APP_USER}/.ssh"
    chmod 700 "/home/${APP_USER}/.ssh"
    chmod 600 "/home/${APP_USER}/.ssh/authorized_keys"
  fi
fi

if [[ ! -d "$APP_DIR" ]]; then
  echo "==> Clone repo"
  sudo -u "$APP_USER" git clone "$REPO" "$APP_DIR"
fi

echo "==> npm install"
cd "${APP_DIR}/server"
sudo -u "$APP_USER" npm install

if [[ ! -f .env ]]; then
  echo "==> .env from example (edit SMTP / keys after setup)"
  sudo -u "$APP_USER" cp .env.example .env
  SECRET=$(openssl rand -hex 24)
  STREAM=$(openssl rand -hex 16)
  sudo -u "$APP_USER" sed -i "s|^SMTP_SECRET_KEY=.*|SMTP_SECRET_KEY=${SECRET}|" .env
  sudo -u "$APP_USER" sed -i "s|^STREAM_KEYS=.*|STREAM_KEYS=${STREAM}|" .env
  sudo -u "$APP_USER" sed -i 's|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://tangent-club.com|' .env
  sudo -u "$APP_USER" sed -i 's|^APP_PUBLIC_URL=.*|APP_PUBLIC_URL=https://tangent-club.com|' .env
  if ! grep -q '^SKIP_EMAIL_VERIFY=' .env; then
    echo "SKIP_EMAIL_VERIFY=1" >> .env
  else
    sudo -u "$APP_USER" sed -i 's|^# SKIP_EMAIL_VERIFY=.*|SKIP_EMAIL_VERIFY=1|' .env
    sudo -u "$APP_USER" sed -i 's|^SKIP_EMAIL_VERIFY=.*|SKIP_EMAIL_VERIFY=1|' .env
  fi
fi

echo "==> systemd"
cat >/etc/systemd/system/tangent-club.service <<EOF
[Unit]
Description=Tangent Club (WHIP + Auth API)
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}/server
Environment=NODE_ENV=production
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now tangent-club

echo "==> nginx (HTTP — run certbot after DNS points here)"
cat >/etc/nginx/sites-available/tangent-club <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name tangent-club.com www.tangent-club.com;

    location / {
        client_max_body_size 6m;
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/tangent-club /etc/nginx/sites-enabled/tangent-club
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

sleep 2
curl -sf http://127.0.0.1:8787/health && echo ""
systemctl --no-pager status tangent-club | head -5

echo ""
echo "Done. Next steps:"
echo "  1) DNS A records: tangent-club.com + www -> this server IP"
echo "  2) certbot --nginx -d tangent-club.com -d www.tangent-club.com"
echo "  3) Update assets/api-config.js to https://tangent-club.com and git push"
echo "  4) Optional: node scripts/verify-user.js USERNAME"
