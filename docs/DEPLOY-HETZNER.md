# Tangent Club auf Hetzner (Ubuntu)

## Voraussetzungen

- Server mit Ubuntu 24.04, SSH-Key auf dem Mac: `~/.ssh/id_ed25519_hetzner`
- DNS **A**-Records: `tangent-club.com` und `www` → Server-IPv4

## 1. Einloggen (Mac)

```bash
ssh -i ~/.ssh/id_ed25519_hetzner root@167.233.30.166
```

## 2. Setup-Skript (auf dem Server als root)

```bash
apt install -y git
git clone https://github.com/svenmagnus/website_02.git /root/website_02
bash /root/website_02/server/scripts/setup-hetzner.sh
```

## 3. HTTPS (nach DNS-Propagierung)

Both hostnames need DNS **A** records to the server IP (otherwise invite links get NXDOMAIN):

```bash
# Check from your Mac:
dig +short tangent-club.com A
dig +short www.tangent-club.com A

certbot --nginx -d tangent-club.com -d www.tangent-club.com
```

In `server/.env` on the VPS (invite/register links in emails):

```bash
APP_PUBLIC_URL=https://tangent-club.com
```

Use `https://www.tangent-club.com` only if `www` resolves in DNS. Restart after change: `systemctl restart tangent-club`.

Reference nginx site config: `docs/nginx-tangent-club.conf`.

## 4. Konto freischalten

```bash
cd /home/tangent/website_02/server
sudo -u tangent node scripts/verify-user.js svenmagnus
```

## 5. Frontend

`assets/api-config.js` → `https://tangent-club.com`, commit & push.

GitHub Pages liefert weiter HTML/JS; API läuft auf dem VPS.

## Updates

**Wichtig:** Auf dem Server ist nur **SSH-Key-Login** aktiv — kein Passwort für `root`.  
Der Key liegt auf dem Mac unter `~/.ssh/id_ed25519_hetzner`.

```bash
# Nach git push origin main — vom Mac im Repo:
./scripts/deploy-production.sh
```

Oder manuell:

```bash
ssh -i ~/.ssh/id_ed25519_hetzner root@167.233.30.166
cd /home/tangent/website_02 && sudo -u tangent git pull
cd server && sudo -u tangent npm install
systemctl restart tangent-club
```

## Logs

```bash
journalctl -u tangent-club -f
```
