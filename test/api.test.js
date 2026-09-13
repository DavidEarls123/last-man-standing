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
    name: 'Office LMS', seasonId: season.seasonId, startGameweek: 1, initialPicks: 3,
  });
  assert.equal(created.status, 201);
  assert.match(created.body.league.join_code, /^[A-Z0-9]{6}$/);
});

test('players register, join with the code and pick for the round coming up', async () => {
  const league = get('SELECT * FROM leagues WHERE name = ?', 'Office LMS');

  const registered = await alice('POST', '/api/auth/register', {
    displayName: 'Alice', email: 'alice@example.com', password: 'correct-horse-battery',
  });
  assert.equal(registered.status, 201);

  const preview = await alice('GET', `/api/leagues/preview/${league.join_code}`);
  assert.equal(preview.body.name, 'Office LMS');
  assert.equal(preview.body.entryClosed, false);

  const joined = await alice('POST', '/api/leagues/join', { code: league.join_code });
  assert.equal(joined.status, 201);

  const teams = await alice('GET', `/api/leagues/${league.id}/rounds/1/teams`);
  assert.equal(teams.body.teams.length, 20);
  const playing = teams.body.teams.filter((team) => team.available);
  assert.equal(playing.length, 20, 'every club has a fixture in a normal gameweek');

  // Only round 1 is open, and one pick is all that is asked for.
  const first = await alice('POST', `/api/leagues/${league.id}/picks`, {
    round: 1, teamId: playing[0].teamId,
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  const ahead = await alice('POST', `/api/leagues/${league.id}/picks`, {
    round: 2, teamId: playing[9].teamId,
  });
  assert.equal(ahead.status, 409);
  assert.match(ahead.body.error.message, /only pick for round 1/i);

  const home = await alice('GET', `/api/leagues/${league.id}/home`);
  assert.equal(home.body.picks.length, 1);
  assert.deepEqual(home.body.openRounds, [1], 'just the round coming up');
  assert.deepEqual(home.body.unpickedOpenRounds, []);
  assert.equal(home.body.needsPick, false);
  assert.equal(home.body.overview.totalEntries, 1);
  assert.equal(home.body.league.entry.status, 'active');
});

test('a league can let entrants pick a few rounds ahead if it wants to', async () => {
  const league = get('SELECT * FROM leagues WHERE name = ?', 'Office LMS');
  assert.equal(
    (await superAdmin('PATCH', `/api/admin/leagues/${league.id}`, { advancePicks: 3 })).status, 200,
  );

  const home = await alice('GET', `/api/leagues/${league.id}/home`);
  assert.deepEqual(home.body.openRounds, [1, 2, 3]);
  assert.deepEqual(home.body.unpickedOpenRounds, [2, 3], 'still nothing they are obliged to do');

  for (const round of [2, 3]) {
    const options = (await alice('GET', `/api/leagues/${league.id}/rounds/${round}/teams`)).body.teams
      .filter((team) => team.available);
    assert.equal(
      (await alice('POST', `/api/leagues/${league.id}/picks`, { round, teamId: options[0].teamId })).status,
      201,
    );
  }
  const tooFar = await alice('POST', `/api/leagues/${league.id}/picks`, { round: 4, teamId: 1 });
  assert.equal(tooFar.status, 409);
  assert.match(tooFar.body.error.message, /up to round 3/i);
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
  const joined = await alice('POST', '/api/leagues/join', { code: second.body.league.join_code });
  assert.equal(joined.status, 201);

  const mine = await alice('GET', '/api/leagues');
  assert.deepEqual(mine.body.leagues.map((league) => league.name).sort(), ['Office LMS', 'Pub LMS']);
});

// A 1x1 transparent PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('the league admin brands the league and sets how far ahead entrants may pick', async () => {
  const league = get('SELECT * FROM leagues WHERE name = ?', 'Office LMS');
  // Give Alice the league so she is acting as a plain league admin.
  await superAdmin('PATCH', `/api/admin/leagues/${league.id}`, { adminEmail: 'alice@example.com' });

  const branded = await alice('PATCH', `/api/leagues/${league.id}`, {
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

  const badColour = await alice('PATCH', `/api/leagues/${league.id}`, { primaryColor: 'tangerine' });
  assert.equal(badColour.status, 400);

  const more = await alice('PATCH', `/api/leagues/${league.id}`, { advancePicks: 5 });
  assert.equal(more.status, 200);
  assert.equal(get('SELECT advance_picks FROM leagues WHERE id = ?', league.id).advance_picks, 5);

  // Rounds 4 and 5 are now within reach for anyone who wants to get ahead.
  const teams = (await alice('GET', `/api/leagues/${league.id}/rounds/5/teams`)).body.teams
    .filter((team) => team.available);
  assert.equal((await alice('POST', `/api/leagues/${league.id}/picks`, {
    round: 5, teamId: teams[0].teamId,
  })).status, 201);
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

  const locked = await alice('POST', `/api/leagues/${leagueId}/lock`);
  assert.equal(locked.status, 200);
  assert.ok(locked.body.lockedAt);

  const after = await alice('PATCH', `/api/leagues/${leagueId}`, { tagline: 'Too late' });
  assert.equal(after.status, 409);
  assert.equal(after.body.error.details?.code ?? after.body.error.code, 'config_locked');
  assert.equal(
    get('SELECT tagline FROM leagues WHERE id = ?', leagueId).tagline, 'Still editable',
    'the locked value stands',
  );

  // Rules are locked too, not just the look.
  assert.equal((await alice('PATCH', `/api/leagues/${leagueId}`, { advancePicks: 4 })).status, 409);

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
