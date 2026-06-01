# Phase 2 — Member accounts & email invites

Phase 2 adds server-backed member accounts, profile sync, and email invitations for guests. The room password on the main page is unchanged (site access); member login is separate.

## Features

| Feature | Where |
|--------|--------|
| Register (invite link or first host) | `register.html` |
| Member login | `login.html` |
| Profile sync | Profile tab → saved to `/api/profile` when logged in |
| Invite guest | Account menu → **Invite guest by email** (requires login) |
| Session | `localStorage` key `dualpeer-member-session` |

## Server setup

```bash
cd server
npm install
cp .env.example .env   # optional
npm run restart
```

### Environment (`.env` or shell)

| Variable | Purpose |
|----------|---------|
| `APP_PUBLIC_URL` | Base URL in invite emails (default `https://www.tangent-club.com`) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Send invite emails |
| `MEMBER_DB_PATH` | Optional path to SQLite DB (default `server/data/members.db`) |

Without SMTP, invites still work: the API returns `inviteUrl` in the JSON response and logs the link in the server console.

## First host account

While the database has **no users**, open:

`https://www.tangent-club.com/register.html`  
(or `http://127.0.0.1:8787/register.html` when using the combined server)

Create username + password. After that, new accounts require an email invitation.

## Guest flow

1. Host signs in (Member login).
2. Host sends invite (email or copy link from API if SMTP off).
3. Guest opens `register.html?token=…`, registers, signs in.
4. Guest joins the session with the usual room password + Peer ID.

## API (prefix `/api`)

| Method | Path | Auth |
|--------|------|------|
| GET | `/auth/status` | — |
| GET | `/auth/invite/:token` | — |
| POST | `/auth/register` | — |
| POST | `/auth/login` | — |
| POST | `/auth/logout` | Bearer |
| GET | `/profile` | Bearer |
| PATCH | `/profile` | Bearer |
| POST | `/invites` | Bearer |

## Production (GitHub Pages + tunnel)

1. Run `npm run restart` and `npm run tunnel` in `server/`.
2. Set `WHIP_CLOUDFLARE_TUNNEL_URL` in `assets/app.js` (same origin serves WHIP + `/api`).
3. Push static files to GitHub Pages.
4. Configure SMTP or share `inviteUrl` manually during testing.

## Files

- `server/db.js`, `server/auth-routes.js`, `server/mail.js`
- `assets/auth.js`, `assets/member-profile.js`
- `login.html`, `register.html`
