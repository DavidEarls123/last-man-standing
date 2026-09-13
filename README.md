# Last Man Standing

A multi-league Last Man Standing platform for Premier League football.

Pick a team each gameweek. If they win you go through; if they draw or lose you are out.
You can only use each club once until all twenty have been used, and the first three picks
must be in before the very first kick off.

## How the competition works

| Rule | Behaviour |
| --- | --- |
| Entry | Anyone with the join code can enter until the **first kick off of the league's start gameweek**. After that the league is sealed. |
| Picking | One pick per round, and nobody has to pick further ahead than the round coming up. Picks can be changed freely right up to the deadline. |
| The deadline | The **first kick off of that gameweek**, identical for everyone. Once it passes the round is shut: no late picks, no changes. |
| Picking ahead | Optional, and only if the league allows it — the admin sets how many rounds ahead entrants *may* pick (1 by default, meaning just the next one). It is never an obligation. |
| Team reuse | A club can be used **once per cycle of 20**. Survive all twenty rounds and every club is available again from round 21. |
| Winning | Your pick must **win**. A draw is not a win. |
| Elimination | One bad round ends your run. Eliminated entrants keep full read access and can follow the league to the end. |
| Missed pick | When the deadline passes, anyone without a pick is handed the **next club they have not used, alphabetically** — one that still has a game to play. (A league can be set to eliminate instead.) |
| Postponed fixtures | Your pick is voided and you are **told to pick again** from whatever in that gameweek has not kicked off yet. The called-off club goes back in your pool. Nothing left to switch to? The round is void and you go through. |
| Special circumstances | The league admin can put an eliminated player back in, with a reason that is recorded and shown. |
| The last one standing | Wins. If every remaining entrant goes out in the same round, they share the win. |

Rounds are numbered from the league's start gameweek, so a league starting at gameweek 12
calls that round 1.

There is one deadline a week and everyone is held to it. Miss it and the competition picks
for you rather than dropping you — see *Missed pick* above.

## Roles

- **Super admin** — one per platform (you). Creates leagues, appoints each league's admin,
  can amend anything: results, picks, entries, league settings, accounts, notification timings.
- **League admin** — exactly one per league. Names and brands the league, sets how far ahead
  entrants may pick, adds players, shares the join link, removes players, puts an eliminated
  player back in, messages entrants. Cannot touch results, and cannot change the setup once it
  is locked.
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

### Making a league your own

Under **Manage**, a league admin sets:

- the **title** and an optional tagline
- **two colours**, which theme that league throughout — header, buttons, progress bars,
  the active tab — so entrants in several leagues can tell them apart at a glance
- a **crest**, uploaded from the phone or desktop and shrunk to 256px in the browser
  before it is sent (PNG, JPEG, WebP, GIF or SVG, under 256KB)
- how many **rounds ahead** entrants may pick, if they like to plan (1 = the next round only)

Colours and crest show up on the invite preview too, so a join link looks like the league.

### Locking the setup

The look and the rules are what entrants sign up to, so they stop moving:

- The league admin presses **Lock setup** when they are happy with it.
- It locks by itself at the first kick off, whether or not anyone pressed the button.
- Once locked, the league admin sees the settings read-only.
- The **super admin can edit straight through a lock** — the form warns them, and the change
  is recorded in the audit log as having superseded it.
- The super admin can also **reopen** a league that has not started yet, with a reason; the
  league admin is emailed to say so. A competition that has already kicked off stays locked
  to its admin either way — at that point the super admin makes the change themselves.

### Notifications

Deadline reminders and results notices go out by email, SMS, or both, following each
player's preferences. Players are also messaged when a fixture is called off and they need
to pick again, and when a missed deadline hands them a club. The super admin sets the timings under **Platform → Notifications**:

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

## The results double-check

Settlement decides one pick at a time from a single fixture lookup. A second, independent
pass then does the opposite: it loads **every** team, gameweek, fixture, entry and pick for
the league, recomputes each result from scratch, and compares that against what was actually
recorded. It runs automatically after every settlement, and on demand from the CLI or either
admin screen.

It checks that:

- each pick's stored outcome and result match what the fixtures and that league's rules give
- every club a pick names is in the season, and has exactly **one** fixture that gameweek —
  a missing or duplicated fixture stops the round settling rather than deciding someone's exit
- each pick's round, gameweek and cycle line up with the league's start gameweek
- no entrant has used the same club twice in a cycle (voided picks aside)
- everyone still in has a pick behind every round that has been played, and no losing pick
- everyone knocked out has something that explains it, in the right round
- the winners on record are the winners the field produces

```bash
npm run verify              # every league; exits non-zero if anything disagrees
npm run verify -- --league=3
```

**Nothing is ever corrected automatically.** A mismatch and an amended score look identical
from here, so the check reports and escalates: it logs the detail, writes an audit entry, and
emails the super admin. Players see a "✓ Checked" line on the league home tab; admins see
exactly which results disagree and can then fix the score and recompute.

## Security notes

- Passwords are bcrypt hashed; sessions are signed JWTs in `HttpOnly`, `SameSite=Lax`
  cookies, with a per-user token version so a password change signs every device out.
- State-changing requests require an `X-Requested-With` header, which blocks cross-site form
  posts on top of the `SameSite` cookie.
- Sign-in, registration, reset and recovery endpoints are rate limited, and eight failed
  sign-ins lock an account for fifteen minutes.
- Everything an admin does is written to an audit log, visible under **Platform → Audit**,
  including edits that superseded a locked setup and every reopening.
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
    verification.js      independent re-check of every recorded result
    notifications.js     outbox, reminder scheduling, email/SMS delivery
    live.js              Server-Sent Events hub for live scores
    football/            local + football-data.org providers
  routes/                auth, leagues (incl. league admin), super admin
  cli/                   bootstrap, seed, demo, verify, superadmin-reset
web/src/
  pages/                 sign in, league list, home, gameweek, pick, admin consoles
test/                    rules unit tests, competition lifecycle, HTTP API
```

## Tests

```bash
npm test
```

Covers the rules in isolation (cycles, draws, called-off fixtures, alphabetical auto-picks,
winner logic), a full competition lifecycle through the services, the reselection flow end to
end, and the HTTP API including access control, league branding and the setup lock. The
verification suite deliberately corrupts a settled league — flipping a result, knocking out a
winner, duplicating a fixture, reusing a club — and checks each one is caught and reported
rather than silently repaired.

## Deployment notes

- The database is a single SQLite file (`data/lms.sqlite`) in WAL mode — back it up by
  copying that directory. Schema changes migrate on boot, crests included.
- Run behind a TLS-terminating proxy; cookies are marked `Secure` when `NODE_ENV=production`.
- One process only: the fixture poller, settlement and notification workers all run in-process
  on timers, so a second instance would duplicate the work.
