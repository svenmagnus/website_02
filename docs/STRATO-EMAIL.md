# E-Mail für Einladungen

## Einfach (empfohlen): einmal Server-SMTP

**Alle Mitglieder** (nicht nur Admins) können Einladungen per E-Mail versenden, sobald in `server/.env` auf dem VPS **ein** Postfach eingetragen ist (z. B. `noreply@tangent-club.com` bei Strato):

```env
SMTP_HOST=smtp.strato.de
SMTP_PORT=465
SMTP_USER=noreply@tangent-club.com
SMTP_PASS=...
SMTP_FROM=noreply@tangent-club.com
```

Kein individuelles Setup pro User nötig. Ohne SMTP: E-Mail-Feld leer lassen und Link + Code kopieren (Instagram, WhatsApp).

## Optional: Strato im Admin-Profil (pro Host)

Nur für **Administratoren** unter **E-Mail server (SMTP)** — eigenes Postfach als Fallback, wenn kein Server-SMTP gesetzt ist.

## Strato eintragen

1. Member login → Account-Menü → **E-Mail-Versand (SMTP)** (Pop-up)
2. **Strato-Werte eintragen** (füllt Vorlage)
3. Deine **E-Mail-Adresse** und **Postfach-Passwort** (wie in Strato Kundenbereich → E-Mail)
4. **E-Mail-Einstellungen speichern** → **Test-E-Mail senden**

| Feld | Strato-Standard |
|------|-----------------|
| Ausgangsserver (SMTP) | `smtp.strato.de` |
| Port | `465` (SSL) — alternativ `587` (STARTTLS) |
| E-Mail / Benutzername | z. B. `name@deine-domain.de` |
| Absender | meist gleiche Adresse |
| Eingang (optional) | `imap.strato.de`, Port `993` |

## Server (Betreiber)

In `server/.env` optional weiterhin **Fallback-SMTP** und Pflicht:

```env
SMTP_SECRET_KEY=ein-langer-zufaelliger-string-min-16-zeichen
```

Ohne `SMTP_SECRET_KEY` werden Postfach-Passwörter in der DB nur mit Dev-Schlüssel verschlüsselt (nicht für Produktion).

## API

| Methode | Pfad |
|---------|------|
| GET | `/api/profile/mail` |
| PATCH | `/api/profile/mail` |
| POST | `/api/profile/mail/test` |

Passwörter werden **nicht** zurückgegeben (`hasPassword: true` wenn gespeichert).
