# Getting it live

Everything you need to take this from a repository on GitHub to a URL your
players can use, with email, texts and two-factor sign in working.

Work through it in order. The whole thing is about an hour if the DNS behaves.

---

## 0. Try it free first

Nothing below needs buying. Run it locally, put it on a public address, and play
out a season — then decide.

```bash
git clone https://github.com/DavidEarls123/last-man-standing.git
cd last-man-standing && npm install && npm run build
npm run seed && npm run demo && npm start     # http://localhost:3000
```

**A free public URL.** Cloudflare hands out throwaway HTTPS addresses with no
account and no card. Install their binary once (`brew install cloudflared`,
`winget install --id Cloudflare.cloudflared`, or
`sudo apt-get install -y cloudflared`), then:

```bash
npm run share
```

It prints something like `https://modern-stack-42d9.trycloudflare.com`, sets
`PUBLIC_URL` to match so invite links work, and dies when you press Ctrl-C. The
address changes each time and only works while your machine is awake — fine for
a weekend of testing, not for a real competition.

**Fast-forward the football.**

```bash
npm run simulate                    # where every league is up to
npm run simulate -- --advance       # play out the next round
npm run simulate -- --rounds=10     # play out ten
npm run simulate -- --deadline=10   # put the next deadline 10 minutes away
```

Advancing a round does what a real weekend does, in order: the deadline passes,
anyone without a pick is handed the next club they have not used, the games are
played, the round is settled. It prints the funnel and cross-checks itself.

**Read the emails without an email account.** Nothing is sent while no provider
is configured; messages are readable under **Platform → Notifications → Recent
messages** and printed to the terminal.

## 1. What this app needs from a host

Three things, and they rule out some popular platforms:

| Requirement | Why |
| --- | --- |
| **A always-on Node process** (Node 22.5+) | The app polls fixtures, settles rounds, sends reminders and streams live scores on timers. A serverless function that sleeps between requests cannot do that. |
| **A persistent disk** | The database is a SQLite file. Platforms with an ephemeral filesystem lose it on every deploy. |
| **Exactly one instance** | The scheduler runs in-process. Two instances would double up on notifications and settle the same round twice. Do not scale it horizontally. |

So: **Vercel, Netlify and GitHub Pages will not work.** Anything that gives you
a small always-on Linux box with a disk will.

### Hosts that suit it

| Option | Cost | Notes |
| --- | --- | --- |
| **A small VPS** (Hetzner, DigitalOcean, Linode) | ~£4–6/month | The most control, and what section 4 walks through. **Recommended: Hetzner CX22** — 2 vCPU, 4GB RAM, 40GB disk, ~£4.50/month, Falkenstein or Helsinki, Ubuntu 24.04. DigitalOcean's $6 London droplet is the same idea with better docs. |
| **Fly.io** | Free tier may cover it | Needs a persistent volume mounted and `min_machines_running = 1`. |
| **Railway / Render** | ~£5/month | Add a persistent disk and pin to one instance. |
| **A Raspberry Pi at home** | Hardware only | Fine for a pub league. Pair with a Cloudflare Tunnel so you do not open ports. |

---

## 1b. How much it can take

Measured on a test platform of 20 leagues, 2,000 entries and 20,000 picks:

| | |
| --- | --- |
| Whole database on disk | 6.8 MB |
| Loading a league's home tab | 4 ms |
| Gameweek popularity and scores | 1 ms |
| Building someone's team picker | 3 ms |
| Re-checking every result in a league | 17 ms |

The database will not be your limit — one small VPS runs tens of thousands of
players across hundreds of leagues. What runs out first, in order:

1. **Your email allowance.** Up to four reminders per player per round, so a
   300/day free tier is roughly 75 players before you need a paid plan (still
   £10–15/month for thousands).
2. **Your SMS bill.** At 4p a message, 200 players × 2 texts a week ≈ £65/month.
   Hence the per-league switch.
3. **Saturday afternoon.** Everyone on live scores at once; each viewer holds an
   open connection. A 4GB box handles thousands, and each gameweek's scores are
   computed once per round rather than once per viewer.
4. **One server.** The scheduler rules out running two copies. Long before that
   mattered you would move to Postgres and split the workers out.

## 2. The database — there is nothing to set up

The app uses **SQLite**, which is a single file, not a server. No Postgres, no
MySQL, no connection strings, no hosted database bill. The file is created
automatically at `data/lms.sqlite` the first time the app starts, and the
schema is applied and migrated on every boot.

What you do need to do:

- **Keep `data/` on a real disk** that survives restarts and deploys.
- **Back it up.** It is one directory. A nightly copy is enough:
  ```bash
  # Consistent snapshot even while the app is running
  sqlite3 /srv/lms/data/lms.sqlite ".backup '/srv/backups/lms-$(date +%F).sqlite'"
  find /srv/backups -name 'lms-*.sqlite' -mtime +30 -delete
  ```
  Put that in a nightly cron job and copy the results off the machine
  (`rclone`, `scp`, S3 — anything).
- **To restore**, stop the app, drop the backup file in as `data/lms.sqlite`,
  delete any `-wal`/`-shm` files beside it, and start again.

SQLite comfortably handles a platform of this size — thousands of players
across dozens of leagues. If you ever outgrow it you would move to Postgres,
which is a code change, not a config one.

---

## 3. Configuration

Copy `.env.example` to `.env` and fill it in. The only value with no working
default is `SESSION_SECRET`.

```bash
cp .env.example .env
openssl rand -hex 48          # paste the result as SESSION_SECRET
```

```ini
NODE_ENV=production
PORT=3000
PUBLIC_URL=https://lms.example.com     # used in every emailed link
SESSION_SECRET=<the 96 characters you just generated>
DATABASE_FILE=/srv/lms/data/lms.sqlite
```

`PUBLIC_URL` must be the address players actually use, or the links in your
emails and texts will point at the wrong place.

Never commit `.env` — it is already in `.gitignore`.

---

## 4. Putting it on a server

This is a Debian/Ubuntu VPS. Adapt as needed.

### 4.1 Install Node and the app

```bash
# Node 22 (or use nvm / fnm)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git sqlite3

sudo mkdir -p /srv/lms && sudo chown "$USER" /srv/lms
git clone https://github.com/DavidEarls123/last-man-standing.git /srv/lms
cd /srv/lms
npm ci                # install server dependencies
npm run build         # build the web app into web/dist
```

### 4.2 Load a season of fixtures

```bash
npm run seed          # sample fixtures, so the app works immediately
```

Replace these with real data as soon as you have an API key — see section 6.

### 4.3 Create your super admin

```bash
npm run bootstrap
```

It asks for your email, an optional mobile and a passphrase of at least 20
characters, then prints two things **once**:

- a **two-factor secret** — add it to your authenticator app now
- **ten recovery codes** — print them or put them in a password manager

Do not skip either. See section 8.

### 4.4 Run it as a service

```ini
# /etc/systemd/system/lms.service
[Unit]
Description=Last Man Standing
After=network.target

[Service]
Type=simple
User=lms
WorkingDirectory=/srv/lms
EnvironmentFile=/srv/lms/.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lms
sudo systemctl status lms
journalctl -u lms -f        # logs
```

### 4.5 A domain and HTTPS

Point an `A` record at the server's IP (`lms.example.com` → `203.0.113.10`),
then let Caddy handle the certificate — it is two lines and renews itself:

```bash
sudo apt-get install -y caddy
```

```caddyfile
# /etc/caddy/Caddyfile
lms.example.com {
    reverse_proxy localhost:3000
}
```

```bash
sudo systemctl reload caddy
```

That is the URL your players use. Set it as `PUBLIC_URL` and restart the app.

<details>
<summary>nginx instead of Caddy</summary>

```nginx
server {
    server_name lms.example.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Live scores stream over SSE and must not be buffered
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```
Then `sudo certbot --nginx -d lms.example.com` for the certificate.
</details>

### 4.6 Deploying an update

```bash
cd /srv/lms && git pull && npm ci && npm run build && sudo systemctl restart lms
```

Schema changes migrate themselves on boot. Take a backup first anyway.

---

## 5. Email

Without this, players get no deadline reminders and no password resets. Out of
the box `EMAIL_PROVIDER=console` just prints messages to the log, which is fine
for testing and useless in production.

### 5.1 Choose a sender

Do **not** send through a personal Gmail account — it will land in spam and may
get you rate limited. Use a transactional email service. Free tiers are
generous enough for a league:

| Service | Free tier |
| --- | --- |
| Brevo (ex-Sendinblue) | 300/day |
| Mailgun | 100/day |
| Postmark | 100/month, best deliverability |
| Amazon SES | 3,000/month, cheapest at volume, fiddliest setup |

### 5.2 Configure it

```ini
EMAIL_PROVIDER=smtp
EMAIL_FROM="Last Man Standing <no-reply@example.com>"
SMTP_URL=smtps://username:password@smtp.brevo.com:465
```

### 5.3 Make sure it arrives

Deliverability is mostly DNS. In your domain's DNS add:

- **SPF** — `TXT @` → `v=spf1 include:<your provider's include> ~all`
- **DKIM** — your provider gives you a `CNAME` or `TXT` record to add
- **DMARC** — `TXT _dmarc` → `v=DMARC1; p=none; rua=mailto:you@example.com`

Every provider documents its exact values. Skipping DKIM is the usual reason
mail goes to spam.

### 5.4 Test it

Sign in as super admin → **Platform → Notifications → Run now**, then check
**Recent messages** for `sent` rather than `failed`.

---

## 6. Real fixtures and live scores

The seeded fixtures are generated samples. For the real Premier League:

1. Register for a free key at <https://www.football-data.org/client/register>.
2. Set:
   ```ini
   FOOTBALL_PROVIDER=football-data
   FOOTBALL_DATA_API_KEY=your_key_here
   FOOTBALL_POLL_SECONDS=60
   ```
3. Restart. Fixtures, kick-off times, live scores and results now come from the
   feed, and gameweek deadlines track the real first kick off.

The free tier allows 10 requests/minute, which one poll a minute sits well
inside. On the free tier in-play scores can lag a little; that only affects the
live tab, not results, which settle from the final score.

**Without an API key** the app still works: the super admin enters scores by
hand under **Platform → Results**, and correcting a score re-settles every
league that used it.

---

## 7. Texts (SMS)

Optional. Email alone is fine, and SMS costs real money (roughly 4p a message
in the UK).

```ini
SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxx
TWILIO_FROM=+447700900000
```

**Three switches control every text**, and all three must be on before one is
sent:

- **Platform → Notifications** — the master switch for the whole platform.
- **Platform → Leagues** — a "Texts: on / off" button per league, so one league
  can have them and the rest stay email only. The league's admin is told.
- **Account → Notifications** — each player picks their own channels.

Buy a UK number in the Twilio console. Two practical points: UK alphanumeric
sender IDs need registration, and any marketing-adjacent messaging needs an
opt-out — deadline reminders are transactional and players choose their
channels in **Account → Notifications**, which covers you for normal use.

---

## 8. Two-factor and admin recovery

**Set this up on day one**, before anyone else joins. The super admin can reach
every league on the platform.

1. `npm run bootstrap` prints a two-factor secret. Add it to Google
   Authenticator, 1Password, Authy or similar.
2. Sign in, go to **Account → Two-factor**, enter the six-digit code and
   confirm. Until you do this, the account is passphrase-only.
3. Store the ten recovery codes offline. Each works once, signs you in, clears
   the second factor so you can re-enrol a new phone, and forces a new
   passphrase. Regenerate them any time under **Platform → Security**.

If you lose everything, you still have the server:

```bash
npm run superadmin:reset                  # new passphrase
npm run superadmin:reset -- --clear-totp  # ...and clear two-factor
```

There is deliberately **no email password reset for the super admin** — that
would make the whole platform only as strong as one inbox, and it is the
easiest thing to phish. Ordinary players do get email/SMS resets.

### Which authenticator

Standard TOTP, so anything works. In order of preference:

1. **Your password manager** (1Password, Bitwarden, iCloud Keychain) — already
   backed up and synced, and it fills the code for you.
2. **Authy** — free, and backs codes up to the cloud, so a lost phone is an
   inconvenience rather than an emergency.
3. **Google or Microsoft Authenticator** — perfectly fine, just no better.

**Not text-message codes.** They can be intercepted by SIM swapping, and for the
account that reaches every league on the platform that is a bad trade. The app
deliberately does not offer them for the super admin.

League admins and players can turn on two-factor for themselves under
**Account** too; it is only compulsory for you.

---

## 9. Notification timings

**Platform → Notifications**, as super admin:

- **Reminder offsets** — minutes before each deadline, sent to anyone who has
  not picked. Default 2880, 1440, 120 (two days, one day, two hours).
- **Final call** — minutes before the deadline, sent to everyone. Default 60.
- **Result notices** — the "you are through" / "you are out" messages.
- **Channels** — turn email or SMS off platform-wide.

Players choose which channels apply to them in **Account → Notifications**.

---

## 10. Running the first competition

1. **Platform → People** → create an account for the person running the league.
2. **Platform → Leagues** → create the league: name, season, start gameweek,
   that person as admin, and the rules (draw policy, missed-pick policy, and
   optionally a locked opening block of 2–10 rounds).
3. They sign in, open **Manage**, set the title, colours and crest (upload one
   or pick a ready-made icon), then **Lock setup**.
4. They share the join code or invite link. Players sign up with an email or
   mobile and join.
5. Entries close automatically at the first kick off of the start gameweek.

---

## 11. Keeping it healthy

```bash
# Cross-check every recorded result against the fixtures; non-zero exit if not
cd /srv/lms && npm run verify
```

Worth a daily cron job — it catches a wrong result before a player does:

```cron
30 6 * * * cd /srv/lms && /usr/bin/npm run verify >> /var/log/lms-verify.log 2>&1
```

Also keep an eye on:

- `journalctl -u lms` for scheduler errors
- **Platform → Checks** for leagues whose results disagree with the fixtures
- **Platform → Notifications → Recent messages** for failed sends
- **Platform → Audit** for who changed what

---

## 12. Before you invite real players

- [ ] HTTPS working, and `PUBLIC_URL` matches it
- [ ] `SESSION_SECRET` set to something random, and not in git
- [ ] Super admin two-factor enrolled, recovery codes stored offline
- [ ] A test email received in an inbox, not the server log
- [ ] Nightly backup running, and a restore tried at least once
- [ ] Real fixtures loaded, or a plan for entering results by hand
- [ ] Notification timings set to suit your players
- [ ] `npm test` passing on the deployed commit

One legal note, not a technical one: if you charge an entry fee and pay out a
prize, a UK Last Man Standing pool can fall under gambling rules. Free-to-enter
competitions, or private pools among people who know each other, are usually
fine — but check the current Gambling Commission guidance before you take money
through the platform.
