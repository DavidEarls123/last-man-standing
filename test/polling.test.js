import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-polling-'));
process.env.DATABASE_FILE = path.join(tmp, 'test.sqlite');
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';

const { all, run } = await import('../src/db/index.js');
const { seedSeason } = await import('../src/db/seed.js');
const { matchWindowOpen, refreshFixtures, resetFetchSchedule } = await import('../src/scheduler.js');

const season = seedSeason({
  seasonName: 'polling-season',
  startDate: new Date(Date.now() + 30 * 86_400_000),
  reset: true,
});

const gameweek = all('SELECT * FROM gameweeks WHERE season_id = ? ORDER BY number', season.seasonId)[0];
const fixture = all('SELECT * FROM fixtures WHERE gameweek_id = ? ORDER BY id', gameweek.id)[0];

const moveKickoff = (offsetMs, status = 'scheduled') => run(
  'UPDATE fixtures SET kickoff = ?, status = ? WHERE id = ?',
  new Date(Date.now() + offsetMs).toISOString(), status, fixture.id,
);

/** A stand-in feed that counts how often it is actually asked. */
function stubProvider({ metered = true, fail = null } = {}) {
  return {
    name: 'stub',
    metered,
    calls: 0,
    async refresh() {
      this.calls += 1;
      if (fail) throw fail;
      return ['changed'];
    },
  };
}

test('a kick off in the next quarter hour opens the match window', () => {
  moveKickoff(10 * 60_000);
  assert.equal(matchWindowOpen(), true);
});

test('a game in play opens the window even mid-match', () => {
  moveKickoff(-60 * 60_000, 'live');
  assert.equal(matchWindowOpen(), true);
});

test('a season weeks away leaves the window shut', () => {
  moveKickoff(20 * 86_400_000);
  assert.equal(matchWindowOpen(), false);
});

test('a metered feed is asked every tick while matches are on', async () => {
  resetFetchSchedule();
  moveKickoff(5 * 60_000);
  const provider = stubProvider();
  await refreshFixtures(Date.now(), provider);
  await refreshFixtures(Date.now() + 60_000, provider);
  assert.equal(provider.calls, 2);
});

test('a metered feed is left alone between matches', async () => {
  resetFetchSchedule();
  moveKickoff(20 * 86_400_000);
  const provider = stubProvider();
  const start = Date.now();
  await refreshFixtures(start, provider);
  // A minute later there is still nothing to see.
  assert.deepEqual(await refreshFixtures(start + 60_000, provider), []);
  assert.equal(provider.calls, 1);
  // A quarter of an hour later there might be.
  await refreshFixtures(start + 16 * 60_000, provider);
  assert.equal(provider.calls, 2);
});

test('the local feed is never held back — it costs nothing', async () => {
  resetFetchSchedule();
  moveKickoff(20 * 86_400_000);
  const provider = stubProvider({ metered: false });
  const start = Date.now();
  await refreshFixtures(start, provider);
  await refreshFixtures(start + 1000, provider);
  assert.equal(provider.calls, 2);
});

test('a rate limit backs off for as long as upstream asks, then resumes', async () => {
  resetFetchSchedule();
  moveKickoff(5 * 60_000);
  const limited = new Error('rate limited');
  limited.retryAfterSeconds = 45;
  const provider = stubProvider({ fail: limited });
  const start = Date.now();
  // The failure is swallowed, not thrown: a shared key hitting its limit is
  // not a reason to take the scheduler down.
  assert.deepEqual(await refreshFixtures(start, provider), []);
  await refreshFixtures(start + 30_000, provider);
  assert.equal(provider.calls, 1, 'still inside the backoff');
  await refreshFixtures(start + 46_000, provider);
  assert.equal(provider.calls, 2, 'backoff expired');
});

test('any other upstream failure still surfaces', async () => {
  resetFetchSchedule();
  const provider = stubProvider({ fail: new Error('boom') });
  await assert.rejects(() => refreshFixtures(Date.now(), provider), /boom/);
});
