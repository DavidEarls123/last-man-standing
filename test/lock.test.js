import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-lock-'));
process.env.DATABASE_FILE = path.join(tmp, 'test.sqlite');
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';

const { createApp } = await import('../src/app.js');
const { all, get, run } = await import('../src/db/index.js');
const { seedSeason } = await import('../src/db/seed.js');
const { hashPassword } = await import('../src/lib/auth.js');

const season = seedSeason({
  seasonName: 'lock-season',
  startDate: new Date(Date.now() + 7 * 86_400_000),
  reset: true,
});

const server = createApp().listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function client() {
  let cookie = '';
  return async function call(method, url, body) {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'lms-web',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const entry of response.headers.getSetCookie?.() ?? []) cookie = entry.split(';')[0];
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}

const boss = client();
const admin = client();
let leagueId;

const PASSPHRASE = 'a-very-long-super-admin-passphrase-1!';
const ADMIN_PASSWORD = 'league-admin-password-1';

test('setup: a league admin launches a league', async () => {
  run(
    `INSERT INTO users (email, display_name, password_hash, is_super_admin, created_at)
     VALUES ('boss@example.com', 'Boss', ?, 1, datetime('now'))`,
    await hashPassword(PASSPHRASE),
  );
  run(
    `INSERT INTO users (email, display_name, password_hash, created_at)
     VALUES ('admin@example.com', 'Club Admin', ?, datetime('now'))`,
    await hashPassword(ADMIN_PASSWORD),
  );
  const adminUser = get("SELECT * FROM users WHERE email = 'admin@example.com'");

  await boss('POST', '/api/auth/login', { identifier: 'boss@example.com', password: PASSPHRASE });
  await admin('POST', '/api/auth/login', { identifier: 'admin@example.com', password: ADMIN_PASSWORD });

  const created = await boss('POST', '/api/admin/leagues', {
    name: 'Killimordaly LMS', seasonId: season.seasonId, startGameweek: 1, openingPicks: 0,
    adminUserId: adminUser.id,
  });
  assert.equal(created.status, 201);
  leagueId = created.body.league.id;

  const launched = await admin('POST', `/api/leagues/${leagueId}/lock`);
  assert.equal(launched.status, 200);
  assert.ok(launched.body.launchedAt);
});

test('a league admin cannot edit the settings they locked', async () => {
  const attempt = await admin('PATCH', `/api/leagues/${leagueId}`, { name: 'Renamed By Admin' });
  assert.equal(attempt.status, 409);
  assert.equal(attempt.body.error.details.code, 'config_locked');
  assert.equal(get('SELECT name FROM leagues WHERE id = ?', leagueId).name, 'Killimordaly LMS');
});

test('a league admin cannot reopen their own lock', async () => {
  const attempt = await admin('POST', `/api/leagues/${leagueId}/unlock`, { reason: 'I changed my mind' });
  assert.equal(attempt.status, 403);
  assert.ok(get('SELECT config_locked_at FROM leagues WHERE id = ?', leagueId).config_locked_at,
    'still locked');
});

test('asking for a change emails every platform admin', async () => {
  const asked = await admin('POST', `/api/leagues/${leagueId}/change-request`, {
    message: 'The start gameweek should be 7, not 1. Nobody has picked yet.',
  });
  assert.equal(asked.status, 201);
  assert.equal(asked.body.notified, 1);
  assert.equal(asked.body.request.status, 'open');

  const queued = all(
    `SELECT n.*, u.email FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.kind = 'change_requested'`,
  );
  assert.equal(queued.length, 1);
  assert.equal(queued[0].email, 'boss@example.com');
  assert.match(queued[0].body, /start gameweek should be 7/);
});

test('a one-word request is refused — the platform admin needs to know what to change', async () => {
  const asked = await admin('POST', `/api/leagues/${leagueId}/change-request`, { message: 'change' });
  assert.equal(asked.status, 400);
});

test('the request shows up on the platform admin overview', async () => {
  const overview = await boss('GET', '/api/admin/overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.body.counts.openChangeRequests, 1);
  assert.equal(overview.body.changeRequests[0].leagueName, 'Killimordaly LMS');
  assert.equal(overview.body.changeRequests[0].requestedByName, 'Club Admin');
});

test('answering it emails the admin back and clears the queue', async () => {
  const overview = await boss('GET', '/api/admin/overview');
  const [request] = overview.body.changeRequests;

  const answered = await boss('POST', `/api/admin/change-requests/${request.id}`, {
    status: 'resolved', outcome: 'Moved it to gameweek 7.',
  });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.request.status, 'resolved');

  const reply = get(
    `SELECT n.*, u.email FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.kind = 'change_answered'`,
  );
  assert.equal(reply.email, 'admin@example.com');
  assert.match(reply.body, /Moved it to gameweek 7/);

  const after = await boss('GET', '/api/admin/overview');
  assert.equal(after.body.counts.openChangeRequests, 0);
});

test('answering the same request twice does nothing the second time', async () => {
  const resolved = get("SELECT id FROM change_requests WHERE status = 'resolved'");
  const again = await boss('POST', `/api/admin/change-requests/${resolved.id}`, { status: 'resolved' });
  assert.equal(again.status, 404);
});

test('reopening the setup answers whatever was outstanding', async () => {
  await admin('POST', `/api/leagues/${leagueId}/change-request`, {
    message: 'Actually the colours are wrong too, they are the away kit.',
  });
  assert.equal((await boss('GET', '/api/admin/overview')).body.counts.openChangeRequests, 1);

  const reopened = await boss('POST', `/api/leagues/${leagueId}/unlock`, { reason: 'Colours wrong' });
  assert.equal(reopened.status, 200);

  const after = await boss('GET', '/api/admin/overview');
  assert.equal(after.body.counts.openChangeRequests, 0, 'reopening is an answer');

  // And now the admin really can edit it.
  const edit = await admin('PATCH', `/api/leagues/${leagueId}`, { name: 'Killimordaly GAA LMS' });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.league.name, 'Killimordaly GAA LMS');
});

test('there is nothing to ask for while the league is unlocked', async () => {
  const asked = await admin('POST', `/api/leagues/${leagueId}/change-request`, {
    message: 'Please change something for me, I cannot do it myself.',
  });
  assert.equal(asked.status, 400);
  assert.match(asked.body.error.message, /not locked/);
});

test.after(() => server.close());
