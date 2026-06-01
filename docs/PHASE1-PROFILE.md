# Phase 1 — Profil & Technik-Anfragen (lokal)

## Was neu ist

- **Reiter** unter dem Video: **Stream** | **Setup** | **Profile**
- **Stream**: kompakte Statuszeilen + Disconnect (Setup ausgeblendet während Live)
- **Setup**: bisherige Connection/WHIP/OBS/Peer-ID
- **Profile**: Name, Geschlecht, Kurztext, Technik-Checkboxen (localStorage)
- **Member-Menü**: Mini-Profil + „My profile“
- **Technique requests**: Buttons aus dem Profil des Partners → Eintrag im **Live Chat**
- **Invite by email**: Platzhalter (Phase 2, deaktiviert)

## Test (zwei Browser / zwei Geräte)

1. Beide: Seite öffnen, einloggen, **Profile** → Techniken ankreuzen → **Save profile**
2. Host: **Setup** → Start as Host  
3. Gast: **Setup** → Connect mit Peer-ID  
4. Nach Verbindung: Reiter wechselt automatisch zu **Stream**
5. Unter **Technique requests**: Buttons des Partners erscheinen
6. Klick auf z. B. „Nipple Play“ → Chat zeigt `You request: …` / `Partner requests: …`

## Speicherung

- Schlüssel: `dualpeer-member-profile-v1` (plus `dualpeer-profile-name` für Kompatibilität)
- Nur dieses Gerät — kein Server (Phase 2)

## Dateien

- `assets/member-profile.js` — Profil-Logik & UI
- `assets/app.js` — Data-Channel (`profile`, `technique_request`)
- `index.html` — Reiter & Formular
