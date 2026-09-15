# Last One Standing

A multi-league last-man-standing platform for Premier League football, and the
first game on **Off The Bridle Sports**.

The platform wears its own colours — deep pitch green with a floodlight-yellow
accent, set in Outfit — everywhere outside a league: sign in, your list of
leagues, your account. Step into a league and its admin's title, crest and two
colours take over until you step back out.

Pick a team each gameweek. If they win you go through; if they draw or lose you are out.
You can only use each club once until all twenty have been used, and the first three picks
must be in before the very first kick off.

## How the competition works

| Rule | Behaviour |
| --- | --- |
| Entry | Anyone with the join code can enter until the **first kick off of the league's start gameweek**. After that the league is sealed. |
| Picking | One pick per round. Only the round coming up needs a pick, but entrants may pick **as far ahead as they like**, and those advance picks stay changeable until their own gameweek kicks off. |
| The deadline | The **first kick off of that gameweek**, identical for everyone. Once it passes the round is shut: no late picks, no changes. |
| Opening block (optional) | Nothing to set up for the ordinary weekly game. A league that wants a committed start can ask for **2 to 10** locked rounds up front, all due before the competition kicks off. (One would be no different from none, so it is not offered.) |
| Opening picks are final | Where a block is set, those picks lock the moment they are saved — chosen or auto-assigned. The app warns before saving one and marks it 🔒. Only a called-off fixture, or the super admin, can change one. |
| Team reuse | A club can be used **once per cycle of 20**, whichever order the rounds are picked in: picking a club for round 15 spends it for rounds 1 to 20 alike. Get through all twenty and every club is available again from round 21, then locks up the same way through rounds 21 to 40. |
| Winning | Your pick must **win**. A draw is not a win. |
| Elimination | One bad round ends your run. Eliminated entrants keep full read access and can follow the league to the end. |
| Missed pick | When a deadline passes, anyone without a pick is handed the **next club they have not used, alphabetically** — one that still has a game to play. The same applies to any opening picks missing when entries close. (A league can be set to eliminate instead.) |
| Postponed fixtures | Your pick is voided and you are **told to pick again** from whatever in that gameweek has not kicked off yet. The called-off club goes back in your pool. Nothing left to switch to? The round is void and you go through. |
| Special circumstances | The league admin can put an eliminated player back in, with a reason that is recorded and shown. |
| The last one standing | Wins. If every remaining entrant goes out in the same round, they share the win. |

Rounds are numbered from the league's start gameweek, so a league starting at gameweek 12
calls that round 1.

There is one deadline a week and everyone is held to it. Miss it and the competition picks
for you rather than dropping you — see *Missed pick* above.

The once-per-cycle rule is enforced three deep: the pick validator refuses it, the write path
refuses it again, and a partial unique index on `picks` makes a duplicate impossible to store
even if both were bypassed. A pick voided by a called-off fixture is the one exception — that
club was never really used, so it returns to the pool, and a fixture that comes back on only
restores the original pick if the club has not been spent elsewhere since.

## Phone and desktop

One build serves both, and the layout changes shape rather than just shrinking:

- **On a phone** the league sections sit in a thumb-friendly bar pinned to the bottom, cards
  stack in one column, and the club picker is two across. Inputs are 16px so iOS does not zoom
  on focus, and the bar clears the home indicator on notched handsets.
- **On a tablet or desktop** that bar becomes a row of pills under the header, content widens
  to a readable 1080px, cards pair up two to a row, the club picker goes to four or five
  across, and single-line fields stop stretching the full width of the screen.

Nothing scrolls sideways at any width from 360px up — there is a Playwright check for that
across every screen, since a stray wide element is the usual way responsive layouts break.

## Roles

- **Super admin** — one per platform (you). Creates leagues, appoints each league's admin,
  can amend anything: results, picks, entries, league settings, accounts, notification timings.
- **League admin** — exactly one per league. Names and brands the league, sets the size of the
  opening block, adds players, shares the join link, removes players, puts an eliminated player
  back in, messages entrants. Cannot touch results, and cannot change the setup once it is
  locked.
- **Player** — one account, any number of leagues. Joins with a code, makes picks, follows
  along after elimination.

## Try it free, before committing to anything

No card, no accounts, no server.

```bash
npm install && npm run build
npm run seed && npm run demo     # sample fixtures and a 16-player league
npm start                        # http://localhost:3000
```

Then three things make it a real test rather than a poke around:

| Command | What it gives you |
| --- | --- |
| `npm run share` | A public HTTPS address anyone can open (`*.trycloudflare.com`), free and with no Cloudflare account. Needs the small `cloudflared` binary; the command tells you how to install it. Send friends the join code and let them pick. |
| `npm run simulate` | Fast-forward the football. `-- --advance` plays out the next round exactly as a real weekend does — deadline passes, missing picks auto-assigned, games played, round settled — and prints who went out and why. `-- --rounds=10` runs a whole season in seconds. |
| `npm run simulate -- --deadline=10` | Moves the next deadline ten minutes away, so you can watch reminders go out and see the auto-pick land on whoever leaves it too late. |

With no email service configured, messages are written down rather than sent: read them under
**Platform → Notifications → Recent messages**, or in the terminal.

Everything carries over when you do go live — same code, same database file.

## Getting it live

[**DEPLOYMENT.md**](DEPLOYMENT.md) is the full walkthrough: hosting, the
database (a SQLite file — nothing to set up), a domain and HTTPS, email and SMS
providers, real fixtures, two-factor and admin recovery, backups and a
pre-launch checklist.

The short version: it needs one always-on Node process with a persistent disk,
so a small VPS or Fly.io rather than Vercel or GitHub Pages.

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

`npm run seed` does one of two things depending on which provider is set.

On `local` it generates a **sample** 38-week calendar from the club list in `data/teams.json`,
so the app is usable end to end before you connect a feed. These are not the real fixtures.

On `football-data` it asks the feed for the current season's clubs *and* the real fixture
list, and each club is stored with its upstream id. Do not rely on `data/teams.json` here:
three or four clubs change every summer, and a club the feed knows about but the database
does not is a fixture that cannot be matched — which quietly removes that club from
everybody's list of possible picks. The seed says so loudly if any club is left unmatched.

Set `FOOTBALL_IDLE_POLL_SECONDS` (default 900) to control how often the feed is polled
between matches. During a match window — anything in play, kicked off within three hours, or
kicking off within fifteen minutes — it polls every `FOOTBALL_POLL_SECONDS` instead. A `429`
backs off for as long as the response's `X-RequestCounter-Reset` header asks.

### Making a league your own

Under **Manage**, a league admin sets:

- the **title** and an optional tagline
- **two colours**, which theme that league throughout — header, buttons, progress bars,
  the active tab — so entrants in several leagues can tell them apart at a glance
- a **crest**: either one of 28 ready-made icons (footballs, trophies, animals, a pint) or
  an uploaded image, shrunk to 256px in the browser before it is sent (PNG, JPEG, WebP or
  GIF, under 256KB)
- an optional **opening block** of 2 to 10 locked rounds, due before the first kick off

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
   `npm run superadmin:reset -- --clear-totp` also clears the second factor. It leaves the
   recovery codes alone on purpose — they are the other way in, and rotating them silently
   would strand whoever holds the printout. Add `--new-codes` when the codes themselves are
   what went wrong. The command says which of the three it changed, every time.

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
