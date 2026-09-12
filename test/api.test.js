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

test('players register, join with the code and pick three teams', async () => {
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

  for (const round of [1, 2, 3]) {
    const options = (await alice('GET', `/api/leagues/${league.id}/rounds/${round}/teams`)).body.teams
      .filter((team) => team.available);
    const picked = await alice('POST', `/api/leagues/${league.id}/picks`, {
      round, teamId: options[0].teamId,
    });
    assert.equal(picked.status, 201, JSON.stringify(picked.body));
  }

  const fourth = await alice('POST', `/api/leagues/${league.id}/picks`, {
    round: 4, teamId: playing[9].teamId,
  });
  assert.equal(fourth.status, 409);
  assert.match(fourth.body.error.message, /rounds 1 to 3/i);

  const home = await alice('GET', `/api/leagues/${league.id}/home`);
  assert.equal(home.body.picks.length, 3);
  assert.equal(home.body.overview.totalEntries, 1);
  assert.equal(home.body.league.entry.status, 'active');
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

test.after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
