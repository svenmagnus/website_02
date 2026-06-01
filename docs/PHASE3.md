# Phase 3 — E-Mail-Versand & Bestätigung

## Ablauf

### 1. Host lädt Gast ein

- Account-Menü → **Invite guest by email** → E-Mail-Adresse des Gastes
- Mit **SMTP** in `server/.env`: Gast erhält E-Mail mit
  - persönlichem Text
  - **Registrierungs-Link** (einmalig, 7 Tage)
  - **6-stelligem Einladungscode** (falls Link nicht öffnet)
- Ohne SMTP: Link + Code nur in der Host-Oberfläche / Server-Konsole (wie bisher)

### 2. Gast registriert sich

- `register.html?token=…` aus der E-Mail **oder** E-Mail + Code manuell
- Felder: **E-Mail**, optional Code, **Benutzername**, Passwort, Profil
- E-Mail muss mit der Einladung übereinstimmen

### 3. E-Mail-Bestätigung (Konto aktivieren)

- Nach Registrierung: **Bestätigungs-E-Mail** mit Link → `verify-email.html`
- Erst danach funktioniert die **Anmeldung**
- Auf `login.html`: „Bestätigung erneut senden“ (Benutzername + Passwort)

### Erster Host (ohne Einladung)

- Solange keine User in der DB: `register.html` ohne Token
- E-Mail + Benutzername Pflicht
- Ohne SMTP: Konto sofort aktiv (lokale Entwicklung)

## SMTP konfigurieren

```bash
cd server
cp .env.example .env
```

| Variable | Beispiel |
|----------|----------|
| `SMTP_HOST` | `smtp.sendgrid.net` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | API-User |
| `SMTP_PASS` | API-Key |
| `SMTP_FROM` | `noreply@tangent-club.com` |
| `APP_PUBLIC_URL` | `https://www.tangent-club.com` |
| `MAIL_SITE_NAME` | `Tangent Club` (optional) |

```bash
npm run restart
```

Test: `curl http://127.0.0.1:8787/api/auth/status` → `"smtpConfigured": true`

## API (neu/geändert)

| Methode | Pfad | Beschreibung |
|---------|------|----------------|
| GET | `/api/auth/verify-email/:token` | E-Mail bestätigen |
| POST | `/api/auth/resend-verification` | Bestätigung erneut senden |
| POST | `/api/auth/register` | Body: `email`, `inviteToken` oder `inviteCode`, `username`, … — **kein** Login-Token mehr; `needsEmailVerification` |
| POST | `/api/auth/login` | `403 email_not_verified` wenn unbestätigt |
| POST | `/api/invites` | Antwort bei Dev: `inviteCode` zusätzlich zu `inviteUrl` |

## Dateien

- `server/mail.js` — HTML-E-Mails (Einladung + Bestätigung)
- `server/auth-routes.js` — Verifikation, Codes
- `server/db.js` — `email`, `email_verified_at`, `invite_code_hash`, `email_verifications`
- `verify-email.html`, `register.html`, `login.html`, `assets/auth.js`
