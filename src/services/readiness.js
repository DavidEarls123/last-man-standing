import fs from 'node:fs';
import path from 'node:path';
import { all, get } from '../db/index.js';
import { config } from '../config.js';
import { notificationSettings } from './notifications.js';

/**
 * Is this installation fit for real people, on machines that are not this one?
 *
 * Running it on your own laptop hides three things that only bite once somebody
 * else is involved: nothing can reach you, no email actually leaves, and an
 * invite link that says localhost means localhost to whoever clicks it. Each
 * check below is either a `blocker` (a real run will not work) or a `note`
 * (fine while it is just you).
 */

const blocker = (title, detail) => ({ level: 'blocker', title, detail });
const note = (title, detail) => ({ level: 'note', title, detail });
const ok = (title, detail) => ({ level: 'ok', title, detail });

export function seasonReport() {
  const season = get('SELECT * FROM seasons WHERE is_current = 1');
  if (!season) return { season: null, checks: [blocker('No season', 'Run `npm run seed`.')] };

  const teams = all('SELECT * FROM teams WHERE season_id = ? ORDER BY name', season.id);
  const orphans = teams.filter((team) => !team.external_ref);
  const counts = get(
    `SELECT COUNT(DISTINCT g.id) AS gameweeks,
            COUNT(f.id)          AS fixtures,
            SUM(CASE WHEN f.external_ref LIKE 'sample-%' THEN 1 ELSE 0 END) AS sample,
            SUM(CASE WHEN f.status = 'finished' THEN 1 ELSE 0 END)          AS finished
       FROM gameweeks g LEFT JOIN fixtures f ON f.gameweek_id = g.id
      WHERE g.season_id = ?`, season.id,
  );
  const next = get(
    `SELECT number, deadline FROM gameweeks
      WHERE season_id = ? AND deadline > datetime('now') ORDER BY deadline LIMIT 1`, season.id,
  );

  const checks = [];
  const live = config.football.provider === 'football-data';
  if (live && counts.sample > 0) {
    checks.push(blocker('Sample fixtures in a live database',
      `${counts.sample} generated fixture(s) remain. Delete data/lms.sqlite and re-seed.`));
  }
  if (live && orphans.length) {
    checks.push(blocker('Clubs the feed does not know',
      `${orphans.map((team) => team.name).join(', ')} — their fixtures cannot be matched, `
      + 'so they never appear as a pick.'));
  }
  if (!live) {
    checks.push(note('Sample fixtures',
      'FOOTBALL_PROVIDER is `local`, so results are invented. Fine for a dry run, not for real players.'));
  }
  if (teams.length !== 20) {
    checks.push(blocker('Wrong number of clubs', `Expected 20, found ${teams.length}.`));
  }
  if (!next) {
    checks.push(note('No deadline ahead', 'Every gameweek has already started.'));
  }
  return { season, teams, counts, next, orphans, checks };
}

/** Everything that is not the football itself. */
export function platformChecks() {
  const checks = [];

  // --- can anyone else actually get in? ---------------------------------
  const url = String(config.publicUrl);
  if (/localhost|127\.0\.0\.1/.test(url)) {
    checks.push(blocker('PUBLIC_URL points at this machine',
      `Invite links will read ${url}, which means "their own computer" to whoever clicks one. `
      + 'Use `npm run share`, which sets it for you, or set PUBLIC_URL to a real address.'));
  } else {
    checks.push(ok('Invite links', url));
  }

  const dist = path.join(config.root, 'web', 'dist', 'index.html');
  if (!fs.existsSync(dist)) {
    checks.push(blocker('Web app not built', 'Run `npm run build`.'));
  }

  if (!process.env.SESSION_SECRET) {
    // Not a blocker: a random secret is generated and kept in
    // data/.dev-session-secret, so sessions are properly signed either way.
    checks.push(note('SESSION_SECRET is not set',
      'A random one is being kept in data/.dev-session-secret. That is secure, but it lives with '
      + 'the database — delete that folder and everyone is signed out. Set it in .env to pin it.'));
  }

  // --- will anything actually be delivered? -----------------------------
  const notify = notificationSettings();
  if (config.email.provider !== 'smtp' || !config.email.smtpUrl) {
    checks.push(blocker('Email is not being sent',
      'EMAIL_PROVIDER is `console`, so invites, deadline reminders and results are printed to '
      + 'this window instead of reaching anyone. Set EMAIL_PROVIDER=smtp and SMTP_URL.'));
  } else {
    checks.push(ok('Email', `smtp, from ${config.email.from}`));
  }
  if (config.sms.provider !== 'twilio') {
    checks.push(note('Texts are not being sent',
      'SMS_PROVIDER is `console`. Email-only is a perfectly normal way to run this.'));
  }
  if (!notify.enabled) {
    checks.push(blocker('Notifications are switched off',
      'Nobody will be reminded of a deadline. Platform → Notifications.'));
  }

  // --- is there anything to play? ---------------------------------------
  const superAdmin = get('SELECT * FROM users WHERE is_super_admin = 1');
  if (!superAdmin) {
    checks.push(blocker('No platform admin', 'Run `npm run bootstrap`.'));
  } else {
    if (!superAdmin.email || !superAdmin.email.includes('@')) {
      checks.push(blocker('The platform admin has no usable email',
        `Sign-in is "${superAdmin.email || superAdmin.phone}". Change requests and alerts go to an `
        + 'inbox, so this needs to be a real address: `npm run bootstrap -- --force --email=...`'));
    }
    if (!superAdmin.totp_enabled) {
      checks.push(note('Platform admin has no second factor',
        'Enrol an authenticator under Account → Two-factor before this is reachable from outside.'));
    }
  }

  const leagues = all('SELECT * FROM leagues');
  const launched = leagues.filter((league) => league.launched_at);
  const unassigned = leagues.filter((league) => !league.admin_user_id);
  if (leagues.length === 0) {
    checks.push(note('No leagues yet', 'Create one under Platform → Leagues and hand it to an admin.'));
  }
  if (unassigned.length) {
    checks.push(note(`${unassigned.length} league(s) have no admin`,
      unassigned.map((league) => league.name).join(', ')));
  }
  if (leagues.length && !launched.length) {
    checks.push(note('Nothing is launched',
      'A league admin has to confirm and launch before anyone can join.'));
  }

  const demoAccounts = get(
    "SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@example.com'",
  ).n;
  if (demoAccounts > 0) {
    checks.push(note(`${demoAccounts} demo account(s) present`,
      'Left over from `npm run demo`. Harmless, but they are in the player lists real people will see.'));
  }

  return checks;
}
