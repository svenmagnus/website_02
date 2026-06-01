# Cloudflare Tunnel (Option A) — www.tangent-club.com + OBS WHIP

Die **Webseite** liegt auf GitHub Pages (`www.tangent-club.com`).  
Der **WHIP-Server** läuft auf deinem Mac (`localhost:8787`).  
Der **Cloudflare-Tunnel** macht den Server unter HTTPS öffentlich erreichbar.

## Voraussetzungen

```bash
brew install cloudflared
cd server && npm install
```

## Jede Session (3 Schritte)

### 1. WHIP-Server starten

```bash
cd server
npm run restart
```

Terminal muss zeigen: `WHIP/WHEP server v16 … on http://localhost:8787`

### 2. Cloudflare-Tunnel starten

Zweites Terminal:

```bash
cd server
npm run tunnel
```

Oder:

```bash
./scripts/cloudflare-tunnel.sh
```

Ausgabe enthält z. B.:

```
https://stored-determining-neutral-agreement.trycloudflare.com
```

**Wichtig:** Bei jedem neuen Quick-Tunnel kann die URL wechseln.

### 3. URL in `assets/app.js` eintragen

```javascript
const WHIP_CLOUDFLARE_TUNNEL_URL =
  "https://DEINE-NEUE-URL.trycloudflare.com";
```

Optional in `server/.env` (für korrekte OBS-URLs in API-Antworten):

```
PUBLIC_BASE_URL=https://DEINE-NEUE-URL.trycloudflare.com
```

Dann Server neu starten (`npm run restart`).

### 4. Webseite deployen

```bash
git add assets/app.js
git commit -m "Update Cloudflare WHIP tunnel URL"
git push
```

Nach GitHub Pages Build: **https://www.tangent-club.com** testen.

## OBS (von überall — auch nicht am Mac-Browser)

1. **www.tangent-club.com** → Start as Host → OBS Server + Bearer Token kopieren  
   (zeigt die Tunnel-URL, z. B. `https://….trycloudflare.com/whip`)
2. OBS → Einstellungen → Stream → WHIP  
3. Server = kopierte URL, Bearer Token = kopierte Zeile  
4. Stream starten

Dein Mac muss laufen mit **Server + Tunnel** — sonst ist die Seite online, aber OBS findet keinen Ingest.

## Test-Checkliste

| Test | Erwartung |
|------|-----------|
| `curl https://DEINE-URL.trycloudflare.com/health` | `{"ok":true,...}` |
| www.tangent-club.com → Start as Host | Kein WHIP-Fehler |
| Browser-Konsole | `[WHIP] tangent-club.com → API https://…` |
| OBS grün + Terminal `[WHIP] rtp video` | Video im Host-Panel |

## Hinweise

- **localhost** nutzt weiterhin `http://127.0.0.1:8787` — kein Tunnel nötig.
- **www.tangent-club.com** nutzt immer `WHIP_CLOUDFLARE_TUNNEL_URL` aus `app.js`.
- Tunnel + Server müssen **gleichzeitig** laufen, solange du live bist.
- Für eine **feste URL** später: Cloudflare Named Tunnel + eigene Subdomain (Option B).
