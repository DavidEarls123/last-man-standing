import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the app at a throwaway database before anything opens it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-competition-'));
process.env.DATABASE_FILE = path.join(tmp, 'test.sqlite');
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';

const { all, get, run } = await import('../src/db/index.js');
const { seedSeason } = await import('../src/db/seed.js');
const { createLeague, joinLeague, leagueContext, leagueOverview } = await import('../src/services/leagues.js');
const { submitPick, entryPicks } = await import('../src/services/picks.js');
const { settleRound, recomputeLeague } = await import('../src/services/settlement.js');
const { applyAutoPicks } = await import('../src/scheduler.js');

// Season starts well in the past so every deadline has already passed and we
// can drive results directly.
const SEASON_START = new Date('2025-08-16T00:00:00.000Z');
const season = seedSeason({ seasonName: 'test-season', startDate: SEASON_START, reset: true });

// A second season whose deadlines are all ahead of us, for the tests that need
// live validation rather than back-dated results.
const futureSeason = seedSeason({
  seasonName: 'future-season',
  startDate: new Date(Date.now() + 7 * 86_400_000),
  reset: true,
});

function makeUser(name) {
  const result = run(
    `INSERT INTO users (email, display_name, password_hash, created_at) VALUES (?, ?, 'x', datetime('now'))`,
    `${name}@example.com`, name,
  );
  return get('SELECT * FROM users WHERE id = ?', Number(result.lastInsertRowid));
}

const teams = () => all('SELECT * FROM teams WHERE season_id = ? ORDER BY id', season.seasonId);

/** Force a result for the team's fixture in a given gameweek. */
function setResult(gameweekNumber, teamId, outcome) {
  const gameweek = get('SELECT * FROM gameweeks WHERE season_id = ? AND number = ?', season.seasonId, gameweekNumber);
  const fixture = get(
    'SELECT * FROM fixtures WHERE gameweek_id = ? AND (home_team_id = ? OR away_team_id = ?)',
    gameweek.id, teamId, teamId,
  );
  const isHome = fixture.home_team_id === teamId;
  const scores = { win: [2, 0], loss: [0, 2], draw: [1, 1] }[outcome];
  run(
    "UPDATE fixtures SET status = 'finished', home_score = ?, away_score = ? WHERE id = ?",
    isHome ? scores[0] : scores[1], isHome ? scores[1] : scores[0], fixture.id,
  );
  return fixture;
}

/** Everything else in the gameweek finishes 0-0 so the round can settle. */
function finishGameweek(gameweekNumber) {
  const gameweek = get('SELECT * FROM gameweeks WHERE season_id = ? AND number = ?', season.seasonId, gameweekNumber);
  run(
    "UPDATE fixtures SET status = 'finished', home_score = COALESCE(home_score, 0), away_score = COALESCE(away_score, 0) WHERE gameweek_id = ?",
    gameweek.id,
  );
}

test('a league runs from entry through elimination to a single winner', () => {
  const owner = makeUser('super');
  const admin = makeUser('leagueadmin');
  const league = createLeague({
    name: 'Test LMS', seasonId: season.seasonId, startGameweek: 1,
    adminUserId: admin.id, createdBy: owner.id,
  });

  const pool = teams();
  const players = ['ann', 'bob', 'cat'].map(makeUser);
  const entries = players.map((player) => joinLeague(league, player.id, { force: true }));

  // Everyone makes their opening three picks (rounds 1-3), all different teams.
  entries.forEach((entry, index) => {
    for (let round = 1; round <= 3; round += 1) {
      submitPick({
        league, entry, round,
        teamId: pool[index * 3 + round - 1].id,
        actorUserId: entry.user_id,
        override: true, // deadlines are in the past in this fixture data
      });
    }
  });
  assert.equal(entryPicks(entries[0].id).length, 3);

  // Round 1: ann wins, bob draws (out by default), cat loses.
  setResult(1, pool[0].id, 'win');
  setResult(1, pool[3].id, 'draw');
  setResult(1, pool[6].id, 'loss');
  finishGameweek(1);

  const round1 = settleRound(league.id, 1);
  assert.equal(round1.settled, true);
  assert.equal(round1.eliminated, 2, 'a draw and a defeat both end a run');
  assert.equal(round1.survived, 1);
  assert.equal(get('SELECT status FROM entries WHERE id = ?', entries[1].id).status, 'eliminated');
  assert.equal(get('SELECT eliminated_reason FROM entries WHERE id = ?', entries[1].id).eliminated_reason, 'draw');

  // Round 2 is only settled once ann's fixture has a result.
  setResult(2, pool[1].id, 'win');
  finishGameweek(2);
  const round2 = settleRound(league.id, 2);
  assert.equal(round2.complete, true, 'one survivor left means the league is done');
  assert.deepEqual(round2.winnerIds, [entries[0].id]);
  assert.equal(get('SELECT status FROM leagues WHERE id = ?', league.id).status, 'completed');
  assert.equal(get('SELECT is_winner FROM entries WHERE id = ?', entries[0].id).is_winner, 1);
});

test('everyone going out in the same round shares the win', () => {
  const owner = makeUser('super2');
  const league = createLeague({
    name: 'Wipeout', seasonId: season.seasonId, startGameweek: 10, createdBy: owner.id,
  });
  const pool = teams();
  const entries = ['dan', 'eve'].map((name) => joinLeague(league, makeUser(name).id, { force: true }));

  entries.forEach((entry, index) => {
    submitPick({ league, entry, round: 1, teamId: pool[index].id, actorUserId: entry.user_id, override: true });
  });
  setResult(10, pool[0].id, 'loss');
  setResult(10, pool[1].id, 'loss');
  finishGameweek(10);

  const result = settleRound(league.id, 1);
  assert.equal(result.complete, true);
  assert.equal(result.winnerIds.length, 2);
  assert.equal(get('SELECT status FROM leagues WHERE id = ?', league.id).status, 'completed');
});

test('a league set to eliminate on a missed deadline does exactly that', () => {
  const owner = makeUser('super3');
  const league = createLeague({
    name: 'No shows', seasonId: season.seasonId, startGameweek: 15, createdBy: owner.id,
    noPickPolicy: 'eliminate',
  });
  const pool = teams();
  const keen = joinLeague(league, makeUser('keen').id, { force: true });
  joinLeague(league, makeUser('absent').id, { force: true });

  submitPick({ league, entry: keen, round: 1, teamId: pool[0].id, actorUserId: keen.user_id, override: true });
  setResult(15, pool[0].id, 'win');
  finishGameweek(15);

  const result = settleRound(league.id, 1);
  assert.equal(result.eliminated, 1);
  const absentEntry = all('SELECT * FROM entries WHERE league_id = ?', league.id)
    .find((entry) => entry.id !== keen.id);
  assert.equal(absentEntry.status, 'eliminated');
  assert.equal(absentEntry.eliminated_reason, 'no_pick');
});

test('by default a missed deadline is settled with the next club alphabetically', () => {
  const owner = makeUser('super3b');
  const league = createLeague({
    name: 'Auto at settlement', seasonId: season.seasonId, startGameweek: 16, createdBy: owner.id,
  });
  const absent = joinLeague(league, makeUser('vanished').id, { force: true });
  finishGameweek(16);

  const result = settleRound(league.id, 1);
  assert.equal(result.settled, true);
  const pick = get(
    `SELECT t.name, p.auto_assigned, p.result FROM picks p JOIN teams t ON t.id = p.team_id
     WHERE p.entry_id = ? AND p.round_number = 1`,
    absent.id,
  );
  const first = get('SELECT name FROM teams WHERE season_id = ? ORDER BY name LIMIT 1', season.seasonId).name;
  assert.equal(pick.name, first, 'the club they were handed');
  assert.equal(pick.auto_assigned, 1);
  assert.notEqual(pick.result, 'pending', 'and it was judged like any other pick');
});

test('a team cannot be reused inside a cycle, and unlocks in the next one', () => {
  const owner = makeUser('super4');
  const league = createLeague({
    // Two rounds open at once, so the reuse rule can be exercised through the
    // normal validated path rather than an override.
    name: 'Cycles', seasonId: futureSeason.seasonId, startGameweek: 1, createdBy: owner.id,
    advancePicks: 2,
  });
  const pool = all('SELECT * FROM teams WHERE season_id = ? ORDER BY id', futureSeason.seasonId);
  const entry = joinLeague(league, makeUser('cyclist').id);

  // Full validation applies here: deadlines are all still ahead of us.
  submitPick({ league, entry, round: 1, teamId: pool[0].id, actorUserId: entry.user_id });

  assert.throws(
    () => submitPick({ league, entry, round: 2, teamId: pool[0].id, actorUserId: entry.user_id }),
    /already used that team/i,
  );
  assert.throws(
    () => submitPick({ league, entry, round: 3, teamId: pool[1].id, actorUserId: entry.user_id }),
    /up to round 2/i,
    'and never further ahead than the league allows',
  );

  // The same team is fine again in round 21 — a fresh cycle of all 20 clubs.
  const context = leagueContext(league);
  assert.equal(context.teamCount, 20);
  submitPick({ league, entry, round: 21, teamId: pool[0].id, actorUserId: entry.user_id, override: true });
  const picks = entryPicks(entry.id);
  assert.deepEqual(picks.map((pick) => pick.round_number), [1, 21]);
  assert.deepEqual(picks.map((pick) => pick.cycle), [0, 1]);
});

test('entries close at the first kick off of the start gameweek', () => {
  const owner = makeUser('super7');
  const openLeague = createLeague({
    name: 'Still open', seasonId: futureSeason.seasonId, startGameweek: 1, createdBy: owner.id,
  });
  assert.ok(joinLeague(openLeague, makeUser('intime').id));

  const closedLeague = createLeague({
    name: 'Too late', seasonId: season.seasonId, startGameweek: 1, createdBy: owner.id,
  });
  assert.throws(() => joinLeague(closedLeague, makeUser('latecomer').id), /Entries closed/i);
  // The super admin can still put someone in by hand.
  assert.ok(joinLeague(closedLeague, makeUser('latecomer2').id, { force: true }));
});

test('overview reports entries, survivors and per-round casualties', () => {
  const owner = makeUser('super5');
  const league = createLeague({
    name: 'Numbers', seasonId: season.seasonId, startGameweek: 20, createdBy: owner.id,
  });
  const pool = teams();
  const entries = ['p1', 'p2', 'p3', 'p4'].map((name) => joinLeague(league, makeUser(name).id, { force: true }));
  entries.forEach((entry, index) => {
    submitPick({ league, entry, round: 1, teamId: pool[index].id, actorUserId: entry.user_id, override: true });
  });
  setResult(20, pool[0].id, 'win');
  setResult(20, pool[1].id, 'win');
  setResult(20, pool[2].id, 'loss');
  setResult(20, pool[3].id, 'loss');
  finishGameweek(20);
  settleRound(league.id, 1);

  const overview = leagueOverview(get('SELECT * FROM leagues WHERE id = ?', league.id));
  assert.equal(overview.totalEntries, 4);
  assert.equal(overview.active, 2);
  assert.equal(overview.eliminated, 2);
  assert.equal(overview.survivalPct, 50);
  assert.deepEqual(overview.rounds[0], {
    round: 1, gameweek: 20, startedWith: 4, eliminated: 2, survivors: 2, survivalPct: 50,
  });
});

test('recompute replays a league after a result is corrected', () => {
  const owner = makeUser('super6');
  const league = createLeague({
    name: 'Corrections', seasonId: season.seasonId, startGameweek: 25, createdBy: owner.id,
  });
  const pool = teams();
  const entry = joinLeague(league, makeUser('wronged').id, { force: true });
  submitPick({ league, entry, round: 1, teamId: pool[0].id, actorUserId: entry.user_id, override: true });

  setResult(25, pool[0].id, 'loss');
  finishGameweek(25);
  settleRound(league.id, 1);
  assert.equal(get('SELECT status FROM entries WHERE id = ?', entry.id).status, 'eliminated');

  // The result was wrong: the pick actually won.
  setResult(25, pool[0].id, 'win');
  recomputeLeague(league.id);
  assert.equal(get('SELECT status FROM entries WHERE id = ?', entry.id).status, 'active');
  assert.equal(get('SELECT result FROM picks WHERE entry_id = ?', entry.id).result, 'survived');
});

test('one hard deadline a week: pick before it, or the next club is picked for you', () => {
  const owner = makeUser('super8');
  const league = createLeague({
    name: 'Weekly', seasonId: futureSeason.seasonId, startGameweek: 1, createdBy: owner.id,
  });
  const pool = all('SELECT * FROM teams WHERE season_id = ? ORDER BY name', futureSeason.seasonId);
  const keen = joinLeague(league, makeUser('organised').id);
  const late = joinLeague(league, makeUser('forgetful2').id);

  // Round 1 is open to both of them, and only round 1.
  submitPick({ league, entry: keen, round: 1, teamId: pool[3].id, actorUserId: keen.user_id });
  assert.throws(
    () => submitPick({ league, entry: keen, round: 2, teamId: pool[4].id, actorUserId: keen.user_id }),
    /only pick for round 1/i,
  );

  // The first kick off arrives — the same moment for everyone.
  const gameweek = get(
    'SELECT * FROM gameweeks WHERE season_id = ? AND number = 1', futureSeason.seasonId,
  );
  run("UPDATE gameweeks SET deadline = datetime('now', '-1 minute') WHERE id = ?", gameweek.id);
  run("UPDATE fixtures SET kickoff = datetime('now', '-1 minute') WHERE gameweek_id = ? AND kickoff = ?",
    gameweek.id, gameweek.deadline);

  assert.throws(
    () => submitPick({ league, entry: late, round: 1, teamId: pool[0].id, actorUserId: late.user_id }),
    /deadline .* has passed/i,
    'nobody sneaks a pick in after the whistle',
  );

  applyAutoPicks(); // runs across every league; check what it did to this one
  assert.equal(
    all('SELECT * FROM picks WHERE league_id = ? AND auto_assigned = 1', league.id).length, 1,
    'only the entrant without a pick is given one',
  );
  const assigned = get(
    `SELECT t.name, p.auto_assigned FROM picks p JOIN teams t ON t.id = p.team_id
     WHERE p.entry_id = ? AND p.round_number = 1`,
    late.id,
  );
  assert.equal(assigned.name, pool[0].name, 'the first club alphabetically that they have not used');
  assert.equal(assigned.auto_assigned, 1);

  // The organised entrant keeps the club they chose, and round 2 is now open.
  assert.equal(
    get('SELECT team_id FROM picks WHERE entry_id = ? AND round_number = 1', keen.id).team_id,
    pool[3].id,
  );
  submitPick({ league, entry: keen, round: 2, teamId: pool[4].id, actorUserId: keen.user_id });
  assert.equal(leagueContext(league).nextOpenRound, 2);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
