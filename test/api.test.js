import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-api-'));
process.env.DATABASE_FILE = path.join(tmp, 'test.sqlite');
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';

const { createApp } = await import('../src/app.js');
const { get, run } = await import('../src/db/index.js');
const { seedSeason } = await import('../src/db/seed.js');
const { hashPassword } = await import('../src/lib/auth.js');

const season = seedSeason({
  seasonName: 'api-season',
  startDate: new Date(Date.now() + 7 * 86_400_000),
  reset: true,
});

const server = createApp().listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

/** Minimal cookie-jar client so sessions survive between calls. */
function client() {
  let cookie = '';
  return async function call(method, url, body, { csrf = true } = {}) {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(csrf ? { 'X-Requested-With': 'lms-web' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const entry of setCookie) cookie = entry.split(';')[0];
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}

const superAdmin = client();
const alice = client();
const bob = client();

test('super admin signs in and builds a league', async () => {
  run(
    `INSERT INTO users (email, display_name, password_hash, is_super_admin, created_at)
     VALUES ('boss@example.com', 'Boss', ?, 1, datetime('now'))`,
    await hashPassword('a-very-long-super-admin-passphrase-1!'),
  );

  const login = await superAdmin('POST', '/api/auth/login', {
    identifier: 'boss@example.com', password: 'a-very-long-super-admin-passphrase-1!',
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.isSuperAdmin, true);

  const created = await superAdmin('POST', '/api/admin/leagues', {
    name: 'Office LMS', seasonId: season.seasonId, startGameweek: 1, openingPicks: 3,
  });
  assert.equal(created.status, 201);
  assert.match(created.body.league.join_code, /^[A-Z0-9]{6}$/);

  // It is a draft until somebody confirms and launches it: no invite is issued
  // and the code does not work, so nobody joins a half-built league.
  const drafts = await superAdmin('GET', '/api/leagues');
  const draft = drafts.body.leagues.find((league) => league.name === 'Office LMS');
  assert.equal(draft.launched, false);
  assert.equal(draft.joinCode, undefined, 'no invite while it is a draft');
  const tooEarly = await superAdmin('GET', `/api/leagues/${draft.id}/members`);
  assert.equal(tooEarly.body.joinUrl, null);
});

test('players register, join with the code and complete the opening block', async () => {
  const league = get('SELECT * FROM leagues WHERE name = ?', 'Office LMS');

  const registered = await alice('POST', '/api/auth/register', {
    displayName: 'Alice', email: 'alice@example.com', password: 'correct-horse-battery',
  });
  assert.equal(registered.status, 201);

  // Joining is refused until the league is launched.
  const early = await alice('POST', '/api/leagues/join', { code: league.join_code });
  assert.equal(early.status, 409);
  assert.match(early.body.error.message, /not been launched/i);

  const launched = await superAdmin('POST', `/api/leagues/${league.id}/lock`);
  assert.equal(launched.status, 200);
  assert.ok(launched.body.launchedAt, 'launching issues the invite');
  assert.equal(launched.body.joinCode, league.join_code);

  const preview = await alice('GET', `/api/leagues/preview/${league.join_code}`);
  assert.equal(preview.body.name, 'Office LMS');
  assert.equal(preview.body.entryClosed, false);

  const joined = await alice('POST', '/api/leagues/join', { code: league.join_code });
  assert.equal(joined.status, 201);

  const teams = await alice('GET', `/api/leagues/${league.id}/rounds/1/teams`);
  assert.equal(teams.body.teams.length, 20);
  const playing = teams.body.teams.filter((team) => team.available);
  assert.equal(playing.length, 20, 'every club has a fixture in a normal gameweek');

  // This league asks for three opening picks, all due before the first kick off.
  const opening = await alice('GET', `/api/leagues/${league.id}/home`);
  assert.equal(opening.body.league.openingPicks, 3);
  assert.deepEqual(opening.body.owedOpeningRounds, [1, 2, 3], 'all three are owed');
  assert.equal(opening.body.openRounds[0], 1);
  assert.ok(opening.body.openRounds.length > 3, 'and the rest of the season is pickable too');

  // Picking further ahead is allowed, just not required.
  const ahead = await alice('POST', `/api/leagues/${league.id}/picks`, {
    round: 6, teamId: playing[9].teamId,
  });
  assert.equal(ahead.status, 201, JSON.stringify(ahead.body));
  assert.equal(
    (await alice('POST', `/api/leagues/${league.id}/picks`, { round: 6, teamId: playing[10].teamId })).status,
    201,
    'and a voluntary pick that far out can still be changed',
  );

  for (const round of [1, 2, 3]) {
    const options = (await alice('GET', `/api/leagues/${league.id}/rounds/${round}/teams`)).body.teams
      .filter((team) => team.available);
    const picked = await alice('POST', `/api/leagues/${league.id}/picks`, {
      round, teamId: options[0].teamId,
    });
    assert.equal(picked.status, 201, JSON.stringify(picked.body));
  }

  const home = await alice('GET', `/api/leagues/${league.id}/home`);
  assert.equal(home.body.picks.length, 4, 'three opening picks plus the one made ahead');
  assert.deepEqual(home.body.owedOpeningRounds, [], 'the block is complete');
  assert.equal(home.body.needsPick, false);
  assert.equal(home.body.overview.totalEntries, 1);
  assert.equal(home.body.league.entry.status, 'active');

  const locked = home.body.picks.filter((pick) => pick.locked).map((pick) => pick.round);
  assert.deepEqual(locked, [1, 2, 3], 'the opening block is flagged as final');
});

test('opening picks cannot be changed once they are in', async () => {
  const league = get('SELECT * FROM leagues WHERE name = ?', 'Office LMS');
  const options = (await alice('GET', `/api/leagues/${league.id}/rounds/2/teams`)).body.teams
    .filter((team) => team.available);

  const swap = await alice('POST', `/api/leagues/${league.id}/picks`, {
    round: 2, teamId: options[0].teamId,
  });
  assert.equal(swap.status, 409);
  assert.equal(swap.body.error.details?.code ?? swap.body.error.code, 'pick_locked');
  assert.match(swap.body.error.message, /locked in/i);

  // The platform admin can still put it right if something has gone wrong.
  const entry = get(
    `SELECT e.* FROM entries e JOIN users u ON u.id = e.user_id
     WHERE e.league_id = ? AND u.email = 'alice@example.com'`,
    league.id,
  );
  const override = await superAdmin(
    'POST', `/api/admin/leagues/${league.id}/entries/${entry.id}/pick`,
    { round: 2, teamId: options[0].teamId },
  );
  assert.equal(override.status, 200);
});

test('a league with no opening block just starts week by week', async () => {
  const created = await superAdmin('POST', '/api/admin/leagues', {
    name: 'Straight in', seasonId: season.seasonId, startGameweek: 1,
  });
  assert.equal(created.body.league.opening_picks, 0, 'no configuration needed');
  const leagueId = created.body.league.id;
  await superAdmin('POST', `/api/leagues/${created.body.league.id}/lock`);
  assert.equal((await alice('POST', '/api/leagues/join', { code: created.body.league.join_code })).status, 201);

  const home = await alice('GET', `/api/leagues/${leagueId}/home`);
  assert.equal(home.body.openRounds[0], 1);
  assert.ok(home.body.openRounds.length > 1, 'later rounds are pickable, just not required');
  assert.deepEqual(home.body.owedOpeningRounds, [], 'nothing is owed up front');
  assert.equal(home.body.needsPick, true, 'just the round coming up, like any other week');

  // And that first pick is not locked, because no block was asked for.
  const options = (await alice('GET', `/api/leagues/${leagueId}/rounds/1/teams`)).body.teams
    .filter((team) => team.available);
  assert.equal((await alice('POST', `/api/leagues/${leagueId}/picks`, {
    round: 1, teamId: options[0].teamId,
  })).status, 201);
  assert.equal((await alice('POST', `/api/leagues/${leagueId}/picks`, {
    round: 1, teamId: options[1].teamId,
  })).status, 201, 'changeable right up to the deadline');
});

test('picks are private until the deadline, popularity is not', async () => {
  const league = get('SELECT * FROM leagues WHERE name = ?', 'Office LMS');
  await bob('POST', '/api/auth/register', {
    displayName: 'Bob', email: 'bob@example.com', password: 'another-good-password',
  });
  await bob('POST', '/api/leagues/join', { code: league.join_code });

  const hidden = await bob('GET', `/api/leagues/${league.id}/rounds/1/picks`);
  assert.equal(hidden.body.revealed, false);
  assert.deepEqual(hidden.body.picks, []);

  const popularity = await bob('GET', `/api/leagues/${league.id}/rounds/1/popularity`);
  assert.equal(popularity.body.totalPicks, 1);
  assert.equal(popularity.body.teams.length, 1, 'only picked teams are listed');
  assert.equal(popularity.body.teams[0].pct, 100);

  const fixtures = await bob('GET', `/api/leagues/${league.id}/rounds/1/fixtures`);
  assert.equal(fixtures.body.fixtures.length, 10);
  const withPick = fixtures.body.fixtures.find((fixture) => fixture.home.picks + fixture.away.picks > 0);
  assert.ok(withPick, 'pick counts sit alongside the fixture');
});

test('access control: admin endpoints, league membership and cross-site posts', async () => {
  const league = get('SELECT * FROM leagues WHERE name = ?', 'Office LMS');

  assert.equal((await alice('GET', '/api/admin/overview')).status, 403);
  assert.equal((await alice('GET', `/api/leagues/${league.id}/members`)).status, 403);
  assert.equal((await superAdmin('GET', `/api/leagues/${league.id}/members`)).status, 200);

  const anonymous = client();
  assert.equal((await anonymous('GET', `/api/leagues/${league.id}/home`)).status, 401);

  const noCsrf = await alice('POST', '/api/leagues/join', { code: league.join_code }, { csrf: false });
  assert.equal(noCsrf.status, 403);
});

test('league admin can add a player and rotate the join code', async () => {
  const league = get('SELECT * FROM leagues WHERE name = ?', 'Office LMS');
  const added = await superAdmin('POST', `/api/leagues/${league.id}/members`, {
    displayName: 'Carol', email: 'carol@example.com',
  });
  assert.equal(added.status, 201);
  assert.match(added.body.temporaryPassword, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  const rotated = await superAdmin('POST', `/api/leagues/${league.id}/join-code`);
  assert.notEqual(rotated.body.joinCode, league.join_code);

  const stale = await bob('POST', '/api/leagues/join', { code: league.join_code });
  assert.equal(stale.status, 404, 'the old code stops working');

  const removed = await superAdmin(
    'DELETE', `/api/leagues/${league.id}/members/${added.body.entryId}`,
  );
  assert.equal(removed.status, 200);
});

test('the same account can enter several leagues', async () => {
  const second = await superAdmin('POST', '/api/admin/leagues', {
    name: 'Pub LMS', seasonId: season.seasonId, startGameweek: 2,
  });
  await superAdmin('POST', `/api/leagues/${second.body.league.id}/lock`);
  const joined = await alice('POST', '/api/leagues/join', { code: second.body.league.join_code });
  assert.equal(joined.status, 201);

  const mine = await alice('GET', '/api/leagues');
  const names = mine.body.leagues.map((league) => league.name);
  assert.ok(names.includes('Pub LMS') && names.length >= 2, JSON.stringify(names));
});

// A 1x1 transparent PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('once a league is launched only the platform admin can restyle or resize it', async () => {
  const league = get('SELECT * FROM leagues WHERE name = ?', 'Office LMS');
  // Give Alice the league so she is acting as a plain league admin.
  await superAdmin('PATCH', `/api/admin/leagues/${league.id}`, { adminEmail: 'alice@example.com' });

  // She confirmed and launched it, so the settings her entrants signed up to
  // are fixed: she has to ask the platform admin now.
  const refused = await alice('PATCH', `/api/leagues/${league.id}`, { tagline: 'Second thoughts' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.details?.code ?? refused.body.error.code, 'config_locked');

  const branded = await superAdmin('PATCH', `/api/leagues/${league.id}`, {
    name: 'The Bell Inn Survivor Cup',
    tagline: 'Last one standing buys nothing',
    primaryColor: '#e4572e',
    secondaryColor: '#17bebb',
    logo: PNG,
  });
  assert.equal(branded.status, 200, JSON.stringify(branded.body));
  assert.equal(branded.body.league.name, 'The Bell Inn Survivor Cup');
  assert.equal(branded.body.league.primaryColor, '#e4572e');
  assert.equal(branded.body.league.logoUrl, `/api/leagues/${league.id}/logo`);

  const logo = await fetch(`${base}/api/leagues/${league.id}/logo`);
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/png');

  const badColour = await superAdmin('PATCH', `/api/leagues/${league.id}`, { primaryColor: 'tangerine' });
  assert.equal(badColour.status, 400);

  // No block, or 2 to 10 — never 1.
  for (const bad of [1, 11, -3]) {
    assert.equal((await superAdmin('PATCH', `/api/leagues/${league.id}`, { openingPicks: bad })).status, 400);
  }
  assert.equal((await superAdmin('PATCH', `/api/leagues/${league.id}`, { openingPicks: 0 })).status, 200);

  const more = await superAdmin('PATCH', `/api/leagues/${league.id}`, { openingPicks: 5 });
  assert.equal(more.status, 200);
  assert.equal(get('SELECT opening_picks FROM leagues WHERE id = ?', league.id).opening_picks, 5);

  // A bigger block means rounds 4 and 5 are now due up front too.
  const teams = (await alice('GET', `/api/leagues/${league.id}/rounds/5/teams`)).body.teams
    .filter((team) => team.available);
  assert.equal((await alice('POST', `/api/leagues/${league.id}/picks`, {
    round: 5, teamId: teams[0].teamId,
  })).status, 201);
  assert.deepEqual((await alice('GET', `/api/leagues/${league.id}/home`)).body.owedOpeningRounds, [4]);
  // Round 6 was picked voluntarily earlier and is now inside the block, so it locks.
  assert.equal(
    (await alice('GET', `/api/leagues/${league.id}/home`)).body.picks.find((pick) => pick.round === 5).locked,
    true,
  );
});

test('setup locks once the admin says it is final, and only the platform admin reopens it', async () => {
  // A league that has not kicked off yet, run by Alice.
  const created = await superAdmin('POST', '/api/admin/leagues', {
    name: 'Locked league', seasonId: season.seasonId, startGameweek: 3, adminEmail: 'alice@example.com',
  });
  const leagueId = created.body.league.id;

  const before = await alice('PATCH', `/api/leagues/${leagueId}`, { tagline: 'Still editable' });
  assert.equal(before.status, 200);
  assert.equal(before.body.league.configLocked, false);

  // Nothing to share while it is a draft.
  assert.equal((await alice('GET', `/api/leagues/${leagueId}/members`)).body.joinCode, null);

  const locked = await alice('POST', `/api/leagues/${leagueId}/lock`);
  assert.equal(locked.status, 200);
  assert.ok(locked.body.lockedAt);
  assert.ok(locked.body.launchedAt, 'confirming is what launches it');

  // Launching is what hands them the invite.
  const invite = await alice('GET', `/api/leagues/${leagueId}/members`);
  assert.equal(invite.body.launched, true);
  assert.match(invite.body.joinCode, /^[A-Z0-9]{6}$/);
  assert.match(invite.body.joinUrl, /\/join\//);

  const after = await alice('PATCH', `/api/leagues/${leagueId}`, { tagline: 'Too late' });
  assert.equal(after.status, 409);
  assert.equal(after.body.error.details?.code ?? after.body.error.code, 'config_locked');
  assert.equal(
    get('SELECT tagline FROM leagues WHERE id = ?', leagueId).tagline, 'Still editable',
    'the locked value stands',
  );

  // Rules are locked too, not just the look.
  assert.equal((await alice('PATCH', `/api/leagues/${leagueId}`, { openingPicks: 4 })).status, 409);

  // The platform admin edits straight through the lock.
  const override = await superAdmin('PATCH', `/api/leagues/${leagueId}`, { tagline: 'Fixed by the platform' });
  assert.equal(override.status, 200);
  assert.equal(override.body.league.tagline, 'Fixed by the platform');
  assert.equal(override.body.league.configLocked, true, 'and it stays locked afterwards');

  // A league admin cannot reopen their own league.
  assert.equal((await alice('POST', `/api/leagues/${leagueId}/unlock`, { reason: 'let me in' })).status, 403);

  const reopened = await superAdmin('POST', `/api/leagues/${leagueId}/unlock`, { reason: 'Wrong crest uploaded' });
  assert.equal(reopened.status, 200);
  assert.equal((await alice('PATCH', `/api/leagues/${leagueId}`, { tagline: 'Editable again' })).status, 200);

  const trail = get(
    "SELECT * FROM audit_log WHERE action = 'league.config_unlocked' AND entity_id = ?", leagueId,
  );
  assert.ok(trail, 'reopening is on the record');
  assert.match(trail.detail, /Wrong crest uploaded/);
});

test('the competition starting locks setup whatever the admin does', async () => {
  // Office LMS started long ago in this fixture's season.
  const league = get('SELECT * FROM leagues WHERE name = ?', 'The Bell Inn Survivor Cup');
  // Clear the launch lock first, so the only thing holding it shut is kick off.
  await superAdmin('POST', `/api/leagues/${league.id}/unlock`, { reason: 'proving the kick-off lock' });
  run("UPDATE gameweeks SET deadline = datetime('now', '-1 day') WHERE season_id = ? AND number = 1", season.seasonId);

  const blocked = await alice('PATCH', `/api/leagues/${league.id}`, { tagline: 'Mid-season rebrand' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error.message, /kicked off/i);

  // Unlocking does not hand the league admin the keys back mid-competition.
  const reopened = await superAdmin('POST', `/api/leagues/${league.id}/unlock`, { reason: 'checking' });
  assert.equal(reopened.body.stillLocked, true);
  assert.equal((await alice('PATCH', `/api/leagues/${league.id}`, { tagline: 'Nope' })).status, 409);
  assert.equal((await superAdmin('PATCH', `/api/leagues/${league.id}`, { tagline: 'Platform can' })).status, 200);

  // Put the fixture data back for the tests that follow.
  run("UPDATE gameweeks SET deadline = datetime('now', '+7 days') WHERE season_id = ? AND number = 1", season.seasonId);
});

test('results are cross-checked and the check is visible to everyone', async () => {
  const league = get('SELECT * FROM leagues WHERE name = ?', 'The Bell Inn Survivor Cup');

  const home = await alice('GET', `/api/leagues/${league.id}/home`);
  assert.equal(home.body.verification.ok, true);
  assert.equal(typeof home.body.verification.picksChecked, 'number');

  const detail = await alice('GET', `/api/leagues/${league.id}/verification`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.ok, true);
  assert.deepEqual(detail.body.issues, []);

  // Players do not get the detailed report.
  assert.equal((await bob('GET', `/api/leagues/${league.id}/verification`)).status, 403);

  const platform = await superAdmin('GET', '/api/admin/verification');
  assert.equal(platform.status, 200);
  assert.ok(platform.body.leagues.length >= 1);
  assert.equal(platform.body.failing, 0);
});

test('a crest can be a ready-made icon instead of an upload', async () => {
  const league = get('SELECT * FROM leagues WHERE name = ?', 'The Bell Inn Survivor Cup');

  const icons = await alice('GET', '/api/leagues/icons');
  assert.equal(icons.status, 200);
  assert.ok(icons.body.icons.length >= 20);
  assert.ok(icons.body.icons.every((icon) => icon.key && icon.emoji && icon.label && icon.group));
  assert.ok(['Sport', 'Animals', 'General'].every(
    (group) => icons.body.icons.some((icon) => icon.group === group),
  ), 'sport, animals and general are all covered');

  const chosen = await superAdmin('PATCH', `/api/leagues/${league.id}`, { logoPreset: 'lion' });
  assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
  assert.equal(chosen.body.league.logoPreset, 'lion');
  assert.equal(chosen.body.league.logoUrl, null, 'choosing an icon clears the uploaded image');

  const madeUp = await superAdmin('PATCH', `/api/leagues/${league.id}`, { logoPreset: 'unicorn-rampant' });
  assert.equal(madeUp.status, 400, 'only crests from the list are accepted');

  // Uploading again replaces the icon.
  const uploaded = await superAdmin('PATCH', `/api/leagues/${league.id}`, { logo: PNG });
  assert.equal(uploaded.body.league.logoPreset, null);
  assert.ok(uploaded.body.league.logoUrl);

  // Stored images are served inertly, whatever they claim to be.
  const served = await fetch(`${base}/api/leagues/${league.id}/logo`);
  assert.match(served.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');

  // SVG is not accepted: it can carry script and we serve from our own origin.
  const svg = await superAdmin('PATCH', `/api/leagues/${league.id}`, {
    logo: 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+',
  });
  assert.equal(svg.status, 400);
});

test('a league admin can put an eliminated player back in', async () => {
  const league = get('SELECT * FROM leagues WHERE name = ?', 'The Bell Inn Survivor Cup');
  const entry = get(
    `SELECT e.* FROM entries e JOIN users u ON u.id = e.user_id
     WHERE e.league_id = ? AND u.email = 'bob@example.com'`,
    league.id,
  );
  run("UPDATE entries SET status = 'eliminated', eliminated_round = 1, eliminated_reason = 'loss' WHERE id = ?", entry.id);

  const noReason = await alice('POST', `/api/leagues/${league.id}/members/${entry.id}/reinstate`, {});
  assert.equal(noReason.status, 400);

  const reinstated = await alice('POST', `/api/leagues/${league.id}/members/${entry.id}/reinstate`, {
    reason: 'App was down when he tried to pick',
  });
  assert.equal(reinstated.status, 200);
  const after = get('SELECT * FROM entries WHERE id = ?', entry.id);
  assert.equal(after.status, 'active');
  assert.equal(after.eliminated_round, null);
  assert.equal(after.reinstated_reason, 'App was down when he tried to pick');

  const again = await alice('POST', `/api/leagues/${league.id}/members/${entry.id}/reinstate`, { reason: 'twice' });
  assert.equal(again.status, 409, 'nothing to reinstate');

  // Players cannot reinstate themselves.
  assert.equal(
    (await bob('POST', `/api/leagues/${league.id}/members/${entry.id}/reinstate`, { reason: 'let me in' })).status,
    403,
  );
});

test.after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('creating a league is just a handover: the admin sets the rules, not the platform', async () => {
  // No start gameweek, no policies — only a name and who is going to run it.
  const created = await superAdmin('POST', '/api/admin/leagues', {
    name: 'Handover FC', seasonId: season.seasonId, adminEmail: 'alice@example.com',
  });
  assert.equal(created.status, 201);
  const league = get('SELECT * FROM leagues WHERE name = ?', 'Handover FC');
  assert.equal(league.opening_picks, 0, 'defaults, for the league admin to change');
  assert.ok(league.start_gameweek >= 1, 'a sensible start gameweek is chosen for them');

  // The league admin now owns the rules, including where the competition starts.
  const saved = await alice('PATCH', `/api/leagues/${league.id}`, {
    startGameweek: 2, drawPolicy: 'survive', noPickPolicy: 'eliminate', anonymousEntrants: true,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.league.startGameweek, 2);
  assert.equal(saved.body.league.drawPolicy, 'survive');
  assert.equal(saved.body.league.anonymousEntrants, true);

  // Configured to their liking, the admin confirms and launches — which is what
  // issues the invite and lets anyone in.
  const live = await alice('POST', `/api/leagues/${league.id}/lock`);
  assert.equal(live.status, 200);
  assert.equal(live.body.joinCode, league.join_code);

  // And cannot move the start once picks exist.
  await alice('POST', '/api/leagues/join', { code: league.join_code });
  await bob('POST', '/api/leagues/join', { code: league.join_code });
  const round = await bob('GET', `/api/leagues/${league.id}/rounds/1/teams`);
  await bob('POST', `/api/leagues/${league.id}/picks`, {
    round: 1, teamId: round.body.teams.find((team) => team.available).teamId,
  });
  const moved = await alice('PATCH', `/api/leagues/${league.id}`, { startGameweek: 3 });
  assert.equal(moved.status, 409);
});

test('an anonymous league hides entrants from each other but not from its admin', async () => {
  const league = get('SELECT * FROM leagues WHERE name = ?', 'Handover FC');
  assert.equal(league.anonymous_entrants, 1);

  const asPlayer = await bob('GET', `/api/leagues/${league.id}/home`);
  assert.equal(asPlayer.body.anonymised, true);
  const others = asPlayer.body.standings.filter((row) => !row.isMe);
  assert.ok(others.length > 0, 'there is somebody else to hide');
  assert.ok(others.every((row) => row.name === null), 'other entrants are not named');
  assert.ok(asPlayer.body.standings.some((row) => row.isMe && row.name), 'you still see yourself');
  // The graph is drawn from these, so the counts must survive anonymising.
  assert.equal(typeof asPlayer.body.overview.totalEntries, 'number');

  const asAdmin = await alice('GET', `/api/leagues/${league.id}/home`);
  assert.equal(asAdmin.body.anonymised, false);
  assert.ok(asAdmin.body.standings.every((row) => row.name), 'the admin still sees who is who');
});

test('a league admin can see what the league has said, theirs and its own', async () => {
  const league = get('SELECT * FROM leagues WHERE name = ?', 'The Bell Inn Survivor Cup');

  const sent = await superAdmin('POST', `/api/leagues/${league.id}/announce`, {
    subject: 'Deadline moved to Friday', message: 'Kick off is earlier this week, get your picks in.',
  });
  assert.equal(sent.status, 200);
  assert.ok(sent.body.queued > 0);

  const log = await superAdmin('GET', `/api/leagues/${league.id}/announcements`);
  assert.equal(log.status, 200);

  // One line per batch, not one per recipient.
  const mine = log.body.batches.filter((batch) => batch.manual);
  assert.equal(mine.length, 1, 'the announcement is one entry however many people got it');
  assert.equal(mine[0].label, 'Announcement');
  assert.match(mine[0].subject, /Deadline moved to Friday/);
  assert.equal(mine[0].counts.total, sent.body.queued);
  assert.ok(mine[0].recipients.length > 1, 'the individual messages are still there behind it');

  // Anything the league sent itself is marked apart from it.
  assert.ok(log.body.batches.every((batch) => typeof batch.manual === 'boolean'));
  assert.ok(log.body.batches.some((batch) => !batch.manual), 'automatic messages are logged too');

  // Players cannot read the league's outbox.
  assert.equal((await bob('GET', `/api/leagues/${league.id}/announcements`)).status, 403);
});

test('a draft league cannot announce to players it does not have', async () => {
  const created = await superAdmin('POST', '/api/admin/leagues', {
    name: 'Silent draft', seasonId: season.seasonId, adminEmail: 'alice@example.com',
  });
  const leagueId = created.body.league.id;
  const tooEarly = await alice('POST', `/api/leagues/${leagueId}/announce`, {
    subject: 'Anybody there', message: 'Hello to nobody at all.',
  });
  assert.equal(tooEarly.status, 409);
  assert.match(tooEarly.body.error.message, /Launch the league/i);
});

test('the platform can run under another name for a trial, and be put back', async () => {
  const before = await fetch(`${base}/api/platform`).then((response) => response.json());
  assert.equal(before.branding.company, 'Off The Bridle Sports');
  assert.equal(before.branding.mark, 'horseshoe');
  assert.equal(before.branding.isDefault, true);

  // A club takes it for a test run.
  const applied = await superAdmin('PUT', '/api/admin/branding', {
    company: 'Killimordaly GAA', mark: 'ball',
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.branding.company, 'Killimordaly GAA');
  assert.equal(applied.body.branding.isDefault, false);

  // Signed out, the sign-in screen sees it too.
  const publicView = await fetch(`${base}/api/platform`).then((response) => response.json());
  assert.equal(publicView.branding.company, 'Killimordaly GAA');
  assert.equal(publicView.branding.mark, 'ball');

  // Nothing about the competition moved.
  const league = get('SELECT * FROM leagues WHERE name = ?', 'The Bell Inn Survivor Cup');
  const home = await alice('GET', `/api/leagues/${league.id}/home`);
  assert.equal(home.status, 200);
  assert.equal(home.body.league.name, 'The Bell Inn Survivor Cup');
  assert.ok(home.body.standings.length > 0, 'entrants are untouched');

  // Only the platform admin may change it.
  assert.equal((await alice('PUT', '/api/admin/branding', { company: 'Alice FC', mark: 'ball' })).status, 403);
  assert.equal((await alice('DELETE', '/api/admin/branding')).status, 403);
  // And only to a mark that exists.
  assert.equal((await superAdmin('PUT', '/api/admin/branding', { company: 'X Club', mark: 'llama' })).status, 400);

  const reverted = await superAdmin('DELETE', '/api/admin/branding');
  assert.equal(reverted.status, 200);
  assert.equal(reverted.body.branding.company, 'Off The Bridle Sports');
  assert.equal(reverted.body.branding.isDefault, true);

  // Both changes are on the record.
  assert.ok(get("SELECT 1 FROM audit_log WHERE action = 'platform.branding_set'"));
  assert.ok(get("SELECT 1 FROM audit_log WHERE action = 'platform.branding_reset'"));
});
