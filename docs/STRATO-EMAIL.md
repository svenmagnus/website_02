# Strato E-Mail im Profil (pro Host)

Jeder eingeloggte Host kann **eigenes Strato-Postfach** unter **Profil → E-Mail-Versand** hinterlegen. Einladungen und (bei Einladung) Bestätigungs-Mails laufen dann über **sein** Konto — nicht über einen zentralen Server-Schlüssel.

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
