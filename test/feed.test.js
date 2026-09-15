import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-feed-'));
process.env.DATABASE_FILE = path.join(tmp, 'test.sqlite');
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';

const { all, get } = await import('../src/db/index.js');
const { seedSeason } = await import('../src/db/seed.js');
const { createFootballDataProvider } = await import('../src/services/football/footballData.js');

/**
 * The clubs a real feed would report — note the two that are nowhere near
 * data/teams.json, which is the whole point: promotion happens every summer.
 */
const UPSTREAM_TEAMS = [
  { id: 57, name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
  { id: 66, name: 'Manchester United FC', shortName: 'Man United', tla: 'MUN' },
  { id: 1076, name: 'Coventry City FC', shortName: 'Coventry City', tla: 'COV' },
  { id: 349, name: 'Ipswich Town FC', shortName: 'Ipswich Town', tla: 'IPS' },
];

const UPSTREAM_MATCHES = [
  {
    id: 900_001, matchday: 1, utcDate: '2026-08-15T14:00:00Z', status: 'FINISHED',
    homeTeam: UPSTREAM_TEAMS[0], awayTeam: UPSTREAM_TEAMS[2],
    score: { fullTime: { home: 2, away: 0 } },
  },
  {
    id: 900_002, matchday: 1, utcDate: '2026-08-15T16:30:00Z', status: 'SCHEDULED',
    homeTeam: UPSTREAM_TEAMS[3], awayTeam: UPSTREAM_TEAMS[1],
    score: { fullTime: { home: null, away: null } },
  },
];

/** Stands in for football-data.org, and records what was asked of it. */
function stubFetch({ teamsStatus = 200, matchesStatus = 200, headers = {} } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const teams = String(url).endsWith('/teams');
    const status = teams ? teamsStatus : matchesStatus;
    const body = teams
      ? { season: { startDate: '2026-08-14' }, teams: UPSTREAM_TEAMS }
      : { matches: UPSTREAM_MATCHES };
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (key) => headers[key.toLowerCase()] ?? null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return calls;
}

const provider = () => createFootballDataProvider({ apiKey: 'test-key', competition: 'PL' });

test('the feed names the season the way a fixture list does', async () => {
  stubFetch();
  assert.equal((await provider().season()).name, '2026/27');
});

test('the feed supplies the clubs, including ones no team file knows about', async () => {
  stubFetch();
  const season = await provider().season();
  assert.deepEqual(
    season.teams.map((team) => team.name).sort(),
    ['Arsenal', 'Coventry City', 'Ipswich Town', 'Man United'],
  );
  // Every club carries its upstream id, which is what fixtures are matched on.
  assert.ok(season.teams.every((team) => team.externalRef));
});

test('seeding from the feed stores the clubs and leaves fixtures to the feed', async () => {
  stubFetch();
  const season = await provider().season();
  const seeded = seedSeason({ seasonName: season.name, teams: season.teams, fixtures: false, reset: true });

  assert.equal(seeded.teams, 4);
  assert.equal(seeded.fixturesCreated, 0);
  assert.equal(
    get('SELECT COUNT(*) AS n FROM teams WHERE season_id = ? AND external_ref IS NULL', seeded.seasonId).n,
    0,
    'every club should carry its upstream id',
  );
});

test('every real fixture then matches — no silently dropped clubs', async () => {
  stubFetch();
  const season = await provider().season();
  const seeded = seedSeason({ seasonName: season.name, teams: season.teams, fixtures: false, reset: true });

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await provider().refresh();
  } finally {
    console.warn = realWarn;
  }

  assert.deepEqual(warnings, [], 'nothing should fail to match');
  const fixtures = all(
    `SELECT f.*, h.name AS home, a.name AS away FROM fixtures f
       JOIN gameweeks g ON g.id = f.gameweek_id
       JOIN teams h ON h.id = f.home_team_id
       JOIN teams a ON a.id = f.away_team_id
      WHERE g.season_id = ? ORDER BY f.kickoff`, seeded.seasonId,
  );
  assert.equal(fixtures.length, 2);
  assert.equal(fixtures[0].home, 'Arsenal');
  assert.equal(fixtures[0].away, 'Coventry City');
  assert.equal(fixtures[0].status, 'finished');
  assert.equal(fixtures[0].home_score, 2);
  assert.equal(fixtures[1].status, 'scheduled');
});

test('the gameweek deadline follows the earliest kickoff in it', async () => {
  stubFetch();
  const season = await provider().season();
  const seeded = seedSeason({ seasonName: season.name, teams: season.teams, fixtures: false, reset: true });
  await provider().refresh();

  const gameweek = get('SELECT * FROM gameweeks WHERE season_id = ? AND number = 1', seeded.seasonId);
  assert.equal(gameweek.deadline, '2026-08-15T14:00:00Z');
});

test('a rate limit is reported as one, with the wait upstream asked for', async () => {
  stubFetch({ matchesStatus: 429, headers: { 'x-requestcounter-reset': '37' } });
  await assert.rejects(
    () => provider().refresh(),
    (error) => error.retryAfterSeconds === 37,
  );
});

test('a rate limit with no reset header still waits rather than hammering', async () => {
  stubFetch({ matchesStatus: 429 });
  await assert.rejects(
    () => provider().refresh(),
    (error) => error.retryAfterSeconds === 60,
  );
});

test('a bad key is still a plain failure, not a backoff', async () => {
  stubFetch({ matchesStatus: 403 });
  await assert.rejects(
    () => provider().refresh(),
    (error) => error.retryAfterSeconds === undefined && /403/.test(error.message),
  );
});
