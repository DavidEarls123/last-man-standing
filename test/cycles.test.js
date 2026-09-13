import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-cycles-'));
process.env.DATABASE_FILE = path.join(tmp, 'test.sqlite');
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';

const { all, get, run } = await import('../src/db/index.js');
const { seedSeason } = await import('../src/db/seed.js');
const { createLeague, joinLeague, leagueContext } = await import('../src/services/leagues.js');
const { availableTeamsForRound, submitPick, usedPicks } = await import('../src/services/picks.js');
const { flagReselections } = await import('../src/services/settlement.js');
const { applyAutoPicks } = await import('../src/scheduler.js');
const { verifyLeague } = await import('../src/services/verification.js');

// A season long enough to run past the 20-team cycle boundary.
const season = seedSeason({
  seasonName: 'cycle-season',
  startDate: new Date(Date.now() + 5 * 86_400_000),
  reset: true,
});

const teams = () => all('SELECT * FROM teams WHERE season_id = ? ORDER BY id', season.seasonId);

let counter = 0;
function makeUser() {
  counter += 1;
  const result = run(
    `INSERT INTO users (email, display_name, password_hash, created_at)
     VALUES (?, ?, 'x', datetime('now'))`,
    `cycle-${counter}@example.com`, `Player ${counter}`,
  );
  return get('SELECT * FROM users WHERE id = ?', Number(result.lastInsertRowid));
}

function newLeague(name, overrides = {}) {
  const league = createLeague({
    name, seasonId: season.seasonId, startGameweek: 1, createdBy: makeUser().id, ...overrides,
  });
  return { league, entry: joinLeague(league, makeUser().id) };
}

test('a club picked ahead is spent everywhere else in the same cycle', () => {
  const { league, entry } = newLeague('Ahead of themselves');
  const pool = teams();

  // Pick well into the future first, then try the same club nearer the front.
  submitPick({ league, entry, round: 15, teamId: pool[0].id, actorUserId: entry.user_id });
  assert.throws(
    () => submitPick({ league, entry, round: 2, teamId: pool[0].id, actorUserId: entry.user_id }),
    /already used that team/i,
    'order of picking makes no difference',
  );
  // And the other way round.
  submitPick({ league, entry, round: 3, teamId: pool[1].id, actorUserId: entry.user_id });
  assert.throws(
    () => submitPick({ league, entry, round: 18, teamId: pool[1].id, actorUserId: entry.user_id }),
    /already used that team/i,
  );

  // The picker agrees with the rule.
  const round2 = availableTeamsForRound(league, entry, 2);
  assert.equal(round2.find((team) => team.teamId === pool[0].id).available, false);
  assert.equal(round2.find((team) => team.teamId === pool[0].id).usedInRound, 15);
  assert.equal(round2.find((team) => team.teamId === pool[2].id).available, true);
});

test('every club reopens for round 21, and locks up again within that cycle', () => {
  const { league, entry } = newLeague('Full cycle');
  const pool = teams();
  assert.equal(leagueContext(league).teamCount, 20);

  // Use all twenty clubs across rounds 1-20.
  pool.forEach((team, index) => {
    submitPick({ league, entry, round: index + 1, teamId: team.id, actorUserId: entry.user_id });
  });
  assert.equal(usedPicks(entry.id).length, 20);

  // By round 20 the only club left is the one already down for that round.
  const round20 = availableTeamsForRound(league, entry, 20).filter((team) => team.available);
  assert.deepEqual(round20.map((team) => team.teamId), [pool[19].id]);
  assert.equal(round20[0].isCurrentPick, true);
  // Round 19 is a better test of exhaustion: nothing free but its own pick.
  assert.deepEqual(
    availableTeamsForRound(league, entry, 19).filter((team) => team.available).map((team) => team.teamId),
    [pool[18].id],
  );
  const reopened = availableTeamsForRound(league, entry, 21);
  assert.equal(reopened.filter((team) => team.available).length, 20, 'all twenty are selectable again');
  assert.ok(reopened.every((team) => team.usedInRound === null));

  // The second cycle behaves exactly like the first.
  submitPick({ league, entry, round: 21, teamId: pool[0].id, actorUserId: entry.user_id });
  assert.throws(
    () => submitPick({ league, entry, round: 25, teamId: pool[0].id, actorUserId: entry.user_id }),
    /already used that team/i,
  );
  assert.match(
    (() => {
      try {
        submitPick({ league, entry, round: 25, teamId: pool[0].id, actorUserId: entry.user_id });
        return '';
      } catch (error) {
        return error.message;
      }
    })(),
    /round 41/,
    'and the entrant is told when it frees up again',
  );
  // Cycle 1 picks are recorded as such.
  assert.equal(get('SELECT cycle FROM picks WHERE entry_id = ? AND round_number = 21', entry.id).cycle, 1);
  assert.equal(verifyLeague(league.id).ok, true);
});

test('the database refuses a duplicate club in a cycle even if validation is bypassed', () => {
  const { league, entry } = newLeague('Belt and braces');
  const pool = teams();
  submitPick({ league, entry, round: 4, teamId: pool[5].id, actorUserId: null, override: true });

  // override skips the rules, but the unique index still stands.
  assert.throws(
    () => submitPick({ league, entry, round: 9, teamId: pool[5].id, actorUserId: null, override: true }),
    /UNIQUE constraint failed/,
  );
  // Across the boundary it is allowed, by the rules and by the database.
  submitPick({ league, entry, round: 24, teamId: pool[5].id, actorUserId: null, override: true });
  assert.equal(
    all('SELECT * FROM picks WHERE entry_id = ? AND team_id = ?', entry.id, pool[5].id).length, 2,
  );
});

test('a club handed out automatically respects picks already made ahead', () => {
  const { league, entry } = newLeague('Auto meets advance', { startGameweek: 2 });
  const pool = all('SELECT * FROM teams WHERE season_id = ? ORDER BY name', season.seasonId);

  // They have already banked the first two clubs alphabetically for later rounds.
  submitPick({ league, entry, round: 6, teamId: pool[0].id, actorUserId: entry.user_id });
  submitPick({ league, entry, round: 7, teamId: pool[1].id, actorUserId: entry.user_id });

  // Round 1 passes with no pick.
  const gameweek = get('SELECT * FROM gameweeks WHERE season_id = ? AND number = 2', season.seasonId);
  run("UPDATE gameweeks SET deadline = datetime('now', '-1 minute') WHERE id = ?", gameweek.id);
  applyAutoPicks();

  const assigned = get(
    `SELECT t.name FROM picks p JOIN teams t ON t.id = p.team_id
     WHERE p.entry_id = ? AND p.round_number = 1`,
    entry.id,
  );
  assert.equal(assigned.name, pool[2].name, 'it skips the two clubs already spoken for');
  assert.equal(verifyLeague(league.id).ok, true);
});

test('a called-off game frees the club, and a reinstated one does not double-book it', () => {
  const { league, entry } = newLeague('Reinstated', { startGameweek: 5 });
  const pool = teams();
  const gameweek = get('SELECT * FROM gameweeks WHERE season_id = ? AND number = 5', season.seasonId);
  const fixture = get(
    'SELECT * FROM fixtures WHERE gameweek_id = ? AND (home_team_id = ? OR away_team_id = ?)',
    gameweek.id, pool[3].id, pool[3].id,
  );

  submitPick({ league, entry, round: 1, teamId: pool[3].id, actorUserId: entry.user_id });
  run("UPDATE fixtures SET status = 'postponed' WHERE id = ?", fixture.id);
  flagReselections();
  assert.equal(get('SELECT outcome FROM picks WHERE entry_id = ? AND round_number = 1', entry.id).outcome, 'void');

  // Voided, so the club is back in their pool and can be used later.
  submitPick({ league, entry, round: 8, teamId: pool[3].id, actorUserId: entry.user_id });

  // Now the game is back on. Restoring the old pick would use that club twice,
  // so it stays open for a replacement instead.
  run("UPDATE fixtures SET status = 'scheduled' WHERE id = ?", fixture.id);
  flagReselections();
  const round1 = get('SELECT * FROM picks WHERE entry_id = ? AND round_number = 1', entry.id);
  assert.equal(round1.outcome, 'void', 'not silently reinstated on top of the later pick');
  assert.equal(
    all("SELECT * FROM picks WHERE entry_id = ? AND team_id = ? AND outcome != 'void'", entry.id, pool[3].id).length,
    1,
    'the club is spent exactly once',
  );
  assert.equal(verifyLeague(league.id).ok, true);
});

test('a reinstated game does restore the pick when the club is still free', () => {
  const { league, entry } = newLeague('Reinstated cleanly', { startGameweek: 6 });
  const pool = teams();
  const gameweek = get('SELECT * FROM gameweeks WHERE season_id = ? AND number = 6', season.seasonId);
  const fixture = get(
    'SELECT * FROM fixtures WHERE gameweek_id = ? AND (home_team_id = ? OR away_team_id = ?)',
    gameweek.id, pool[4].id, pool[4].id,
  );

  submitPick({ league, entry, round: 1, teamId: pool[4].id, actorUserId: entry.user_id });
  run("UPDATE fixtures SET status = 'postponed' WHERE id = ?", fixture.id);
  flagReselections();
  run("UPDATE fixtures SET status = 'scheduled' WHERE id = ?", fixture.id);
  flagReselections();

  const round1 = get('SELECT * FROM picks WHERE entry_id = ? AND round_number = 1', entry.id);
  assert.equal(round1.needs_reselect, 0);
  assert.equal(round1.outcome, 'pending', 'the original pick stands again');
  // And it counts as spent once more.
  assert.throws(
    () => submitPick({ league, entry, round: 9, teamId: pool[4].id, actorUserId: entry.user_id }),
    /already used that team/i,
  );
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
