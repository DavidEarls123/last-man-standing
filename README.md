# Last Man Standing

A multi-league Last Man Standing platform for Premier League football.

Pick a team each gameweek. If they win you go through; if they draw or lose you are out.
You can only use each club once until all twenty have been used, and the first three picks
must be in before the very first kick off.

## How the competition works

| Rule | Behaviour |
| --- | --- |
| Entry | Anyone with the join code can enter until the **first kick off of the league's start gameweek**. After that the league is sealed. |
| Opening picks | Before that first kick off every entrant chooses teams for rounds **1, 2 and 3** (configurable per league). |
| Ongoing picks | From round 4 on, one pick per round, due before that gameweek's first kick off. Picks can be changed right up to the deadline. |
| Team reuse | A club can be used **once per cycle of 20**. Survive all twenty rounds and every club is available again from round 21. |
| Winning | Your pick must **win**. A draw is not a win. |
| Elimination | One bad round ends your run. Eliminated entrants keep full read access and can follow the league to the end. |
| Missed pick | No pick by the deadline means you are out (a league can instead be set to auto-pick at random). |
| Postponed fixtures | Treated as no result, which by default eliminates (configurable per league). |
| The last one standing | Wins. If every remaining entrant goes out in the same round, they share the win. |

Rounds are numbered from the league's start gameweek, so a league starting at gameweek 12
calls that round 1.

## Roles

- **Super admin** — one per platform (you). Creates leagues, appoints each league's admin,
  can amend anything: results, picks, entries, league settings, accounts, notification timings.
- **League admin** — exactly one per league. Adds players, shares the join link, removes
  players, messages entrants, renames the league. Cannot touch results.
- **Player** — one account, any number of leagues. Joins with a code, makes picks, follows
  along after elimination.

## Getting started

```bash
npm install                # server dependencies
npm run seed               # load a season of sample fixtures
npm run bootstrap          # create the super admin (interactive)
npm run build              # build the web app
npm start                  # http://localhost:3000
```

For development, run the API and the Vite dev server side by side:

```bash
npm run dev                # API on :3000
npm run dev:web            # UI on :5173, proxying /api to :3000
```

### Try it with demo data

```bash
npm run demo               # a 16-player league mid-competition
SIMULATE_LIVE=true npm start
```

Every demo account uses the password `demo-password-1234`; the script prints the league
admin's address and the join code. `SIMULATE_LIVE=true` drives fake in-play scores from the
sample fixtures so the live tab has something to show.

## Configuration

Copy `.env.example` to `.env`. `SESSION_SECRET` is the only value that must be set in
production (`openssl rand -hex 48`).

### Football data

| `FOOTBALL_PROVIDER` | Behaviour |
| --- | --- |
| `local` (default) | Fixtures and results live in this database. The super admin enters scores under **Platform → Results**, or `SIMULATE_LIVE=true` generates them. |
| `football-data` | Real Premier League fixtures, scores and in-play state polled from [football-data.org](https://www.football-data.org/). Set `FOOTBALL_DATA_API_KEY`. Matchdays map onto gameweeks and each gameweek's deadline tracks its earliest kick off. |

The fixtures loaded by `npm run seed` are **generated sample data**, not the real calendar —
they exist so the app is usable end to end before you connect a feed. Club names come from
`data/teams.json`; edit that file for a different season.

### Notifications

Deadline reminders and results notices go out by email, SMS, or both, following each
player's preferences. The super admin sets the timings under **Platform → Notifications**:

- reminder offsets, in minutes before each deadline (default 48h, 24h, 2h) — sent to anyone
  who has not picked yet
- a final call (default 1h) sent to everyone in the round
- whether "you are through" / "you are out" notices go out at all
- which channels are enabled platform-wide

| Channel | Providers |
| --- | --- |
| Email | `console` (prints to the server log — the default), `smtp` (set `SMTP_URL`) |
| SMS | `console`, `twilio` (set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`) |

Messages are written to a `notifications` outbox table and delivered by a background worker,
so nothing is lost if the mail server is briefly down, and every send is visible to the
super admin.

## Super admin account recovery

The super admin can reach every league on the platform, so the account is deliberately
harder to get into — and harder to lose. There are three ways in, in order of preference:

1. **Passphrase + authenticator app.** The passphrase must be at least 20 characters and mix
   character classes; TOTP is set up during `npm run bootstrap` and confirmed in
   **Account → Two-factor**.
2. **A one-time recovery code.** Ten are printed once by `npm run bootstrap` — store them
   offline (a password manager or a printout in a safe). Each code works once, signs you in,
   clears the second factor so a lost authenticator can be re-enrolled, and forces a new
   passphrase. Generate a fresh set any time under **Platform → Security**.
3. **Shell access to the server.** `npm run superadmin:reset` sets a new passphrase, and
   `npm run superadmin:reset -- --clear-totp` also clears the second factor.

There is deliberately **no email password reset for the super admin**. An email reset would
make the whole platform only as strong as one inbox, and it is the easiest thing to phish.
The break-glass path is the CLI, which requires access to the machine itself.

Ordinary players do get email/SMS resets, and the reset link expires after an hour.

## Security notes

- Passwords are bcrypt hashed; sessions are signed JWTs in `HttpOnly`, `SameSite=Lax`
  cookies, with a per-user token version so a password change signs every device out.
- State-changing requests require an `X-Requested-With` header, which blocks cross-site form
  posts on top of the `SameSite` cookie.
- Sign-in, registration, reset and recovery endpoints are rate limited, and eight failed
  sign-ins lock an account for fifteen minutes.
- Everything an admin does is written to an audit log, visible under **Platform → Audit**.
- Individual picks are hidden from other players until the round's deadline passes. Aggregate
  popularity (how many entrants are on each team) is public throughout, which is what the
  gameweek tab is for.

## Project layout

```
src/
  domain/rules.js        pure competition rules — rounds, cycles, outcomes, winners
  services/
    leagues.js           league state: rounds, deadlines, standings, overview
    picks.js             availability, submission, popularity, live pick counts
    settlement.js        settle a round, eliminate, decide winners, recompute
    notifications.js     outbox, reminder scheduling, email/SMS delivery
    live.js              Server-Sent Events hub for live scores
    football/            local + football-data.org providers
  routes/                auth, leagues (incl. league admin), super admin
  cli/                   bootstrap, seed, demo, superadmin-reset
web/src/
  pages/                 sign in, league list, home, gameweek, pick, admin consoles
test/                    rules unit tests, competition lifecycle, HTTP API
```

## Tests

```bash
npm test
```

Covers the rules in isolation (cycles, draws, void fixtures, winner logic), a full
competition lifecycle through the services, and the HTTP API including access control.

## Deployment notes

- The database is a single SQLite file (`data/lms.sqlite`) in WAL mode — back it up by
  copying that directory.
- Run behind a TLS-terminating proxy; cookies are marked `Secure` when `NODE_ENV=production`.
- One process only: the fixture poller, settlement and notification workers all run in-process
  on timers, so a second instance would duplicate the work.
