import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-reselect-'));
process.env.DATABASE_FILE = path.join(tmp, 'test.sqlite');
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';

const { all, get, run } = await import('../src/db/index.js');
const { seedSeason } = await import('../src/db/seed.js');
const { createLeague, joinLeague } = await import('../src/services/leagues.js');
const { availableTeamsForRound, submitPick } = await import('../src/services/picks.js');
const { flagReselections, settleRound } = await import('../src/services/settlement.js');

// Gameweek 1 kicks off in an hour, with the rest of the round spread later,
// so a postponement leaves real alternatives on the table.
const season = seedSeason({
  seasonName: 'reselect-season',
  startDate: new Date(Date.now() + 3 * 86_400_000),
  reset: true,
});

const gameweek = (number) =>
  get('SELECT * FROM gameweeks WHERE season_id = ? AND number = ?', season.seasonId, number);

function makeUser(name) {
  const result = run(
    `INSERT INTO users (email, display_name, password_hash, created_at)
     VALUES (?, ?, 'x', datetime('now'))`,
    `${name}@example.com`, name,
  );
  return get('SELECT * FROM users WHERE id = ?', Number(result.lastInsertRowid));
}

function setUp(name, startGameweek = 1, overrides = {}) {
  const owner = makeUser(`${name}-owner`);
  const league = createLeague({
    launched: true,
    name, seasonId: season.seasonId, startGameweek, createdBy: owner.id, ...overrides,
  });
  const entry = joinLeague(league, makeUser(`${name}-player`).id, { force: true });
  return { league, entry };
}

test('a called-off fixture opens a reselection instead of ending a run', () => {
  const { league, entry } = setUp('Postponed');
  const teams = all('SELECT * FROM teams WHERE season_id = ? ORDER BY id', season.seasonId);

  // Pick the team playing in the earliest kick off of gameweek 1.
  const first = get('SELECT * FROM fixtures WHERE gameweek_id = ? ORDER BY kickoff LIMIT 1', gameweek(1).id);
  const picked = teams.find((team) => team.id === first.home_team_id);
  submitPick({ league, entry, round: 1, teamId: picked.id, actorUserId: entry.user_id });

  assert.equal(flagReselections(), 0, 'nothing to do while the game is on');

  run("UPDATE fixtures SET status = 'postponed' WHERE id = ?", first.id);
  assert.equal(flagReselections(), 1);

  const pick = get('SELECT * FROM picks WHERE entry_id = ? AND round_number = 1', entry.id);
  assert.equal(pick.needs_reselect, 1);
  assert.equal(pick.outcome, 'void');
  assert.ok(pick.reselect_deadline, 'they are told how long they have');
  assert.equal(get('SELECT status FROM entries WHERE id = ?', entry.id).status, 'active');

  const notice = get(
    "SELECT * FROM notifications WHERE kind = 'reselect_required' AND league_id = ?", league.id,
  );
  assert.ok(notice, 'the entrant is notified');
  assert.match(notice.subject, /game is off/i);

  // Running again does not re-notify.
  assert.equal(flagReselections(), 0);
});

test('the replacement must be a game that has not kicked off, and the old club is freed', () => {
  const { league, entry } = setUp('Replacements', 2);
  const fixtures = all('SELECT * FROM fixtures WHERE gameweek_id = ? ORDER BY kickoff', gameweek(2).id);
  const picked = fixtures[0].home_team_id;
  submitPick({ league, entry, round: 1, teamId: picked, actorUserId: entry.user_id });

  run("UPDATE fixtures SET status = 'postponed' WHERE id = ?", fixtures[0].id);
  // A later game in the same round has already been played.
  run("UPDATE fixtures SET status = 'finished', home_score = 2, away_score = 0 WHERE id = ?", fixtures[1].id);
  flagReselections();

  const options = availableTeamsForRound(league, entry, 1);
  const playedTeam = options.find((team) => team.teamId === fixtures[1].home_team_id);
  assert.equal(playedTeam.available, false, 'no picking a result you already know');

  const stillToPlay = options.find((team) => team.teamId === fixtures[2].away_team_id);
  assert.equal(stillToPlay.available, true);

  assert.throws(
    () => submitPick({ league, entry, round: 1, teamId: fixtures[1].home_team_id, actorUserId: entry.user_id }),
    /not kicked off/i,
  );

  submitPick({ league, entry, round: 1, teamId: stillToPlay.teamId, actorUserId: entry.user_id });
  const pick = get('SELECT * FROM picks WHERE entry_id = ? AND round_number = 1', entry.id);
  assert.equal(pick.team_id, stillToPlay.teamId);
  assert.equal(pick.needs_reselect, 0);
  assert.equal(pick.outcome, 'pending');

  // The postponed club never played for them, so it is selectable again later.
  const laterRound = availableTeamsForRound(league, entry, 2).find((team) => team.teamId === picked);
  assert.equal(laterRound.available, true);
  assert.equal(laterRound.usedInRound, null);
});

test('with nothing left to switch to, a void pick goes through rather than out', () => {
  const { league, entry } = setUp('Nothing left', 3);
  const fixtures = all('SELECT * FROM fixtures WHERE gameweek_id = ? ORDER BY kickoff', gameweek(3).id);
  submitPick({ league, entry, round: 1, teamId: fixtures[0].home_team_id, actorUserId: entry.user_id });

  // The whole gameweek is done bar the one that was called off.
  run("UPDATE fixtures SET status = 'finished', home_score = 1, away_score = 0 WHERE gameweek_id = ?", gameweek(3).id);
  run("UPDATE fixtures SET status = 'postponed', home_score = NULL, away_score = NULL WHERE id = ?", fixtures[0].id);
  run("UPDATE gameweeks SET deadline = datetime('now', '-1 hour') WHERE id = ?", gameweek(3).id);

  flagReselections();
  const result = settleRound(league.id, 1);
  assert.equal(result.settled, true);
  assert.equal(result.eliminated, 0);
  assert.equal(get('SELECT status FROM entries WHERE id = ?', entry.id).status, 'active');
  const pick = get('SELECT * FROM picks WHERE entry_id = ? AND round_number = 1', entry.id);
  assert.equal(pick.outcome, 'void');
  assert.equal(pick.result, 'survived');
  assert.equal(pick.needs_reselect, 0);
});

test('a league can still choose to eliminate on a void', () => {
  const { league, entry } = setUp('Strict', 4, { voidPolicy: 'eliminate' });
  const fixtures = all('SELECT * FROM fixtures WHERE gameweek_id = ? ORDER BY kickoff', gameweek(4).id);
  submitPick({ league, entry, round: 1, teamId: fixtures[0].home_team_id, actorUserId: entry.user_id });

  run("UPDATE fixtures SET status = 'finished', home_score = 1, away_score = 0 WHERE gameweek_id = ?", gameweek(4).id);
  run("UPDATE fixtures SET status = 'postponed', home_score = NULL, away_score = NULL WHERE id = ?", fixtures[0].id);
  run("UPDATE gameweeks SET deadline = datetime('now', '-1 hour') WHERE id = ?", gameweek(4).id);

  assert.equal(flagReselections(), 0, 'strict leagues are left alone');
  settleRound(league.id, 1);
  const entryAfter = get('SELECT * FROM entries WHERE id = ?', entry.id);
  assert.equal(entryAfter.status, 'eliminated');
  assert.equal(entryAfter.eliminated_reason, 'void');
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('a reselection nobody acts on falls back to the alphabetical assignment', async () => {
  const { applyAutoPicks } = await import('../src/scheduler.js');
  const { league, entry } = setUp('Lapsed', 5);
  const fixtures = all('SELECT * FROM fixtures WHERE gameweek_id = ? ORDER BY kickoff', gameweek(5).id);
  const picked = fixtures[0].home_team_id;
  submitPick({ league, entry, round: 1, teamId: picked, actorUserId: entry.user_id });

  run("UPDATE fixtures SET status = 'postponed' WHERE id = ?", fixtures[0].id);
  assert.equal(flagReselections(), 1);

  const opened = get('SELECT * FROM picks WHERE entry_id = ? AND round_number = 1', entry.id);
  assert.equal(opened.needs_reselect, 1);
  // Still in the window: they are being asked, not judged.
  assert.equal(applyAutoPicks(), 0, 'nothing is assigned while they can still pick');

  // Let the replacement window run out without them picking again.
  run("UPDATE picks SET reselect_deadline = ? WHERE id = ?", new Date(Date.now() - 60_000).toISOString(), opened.id);
  assert.equal(applyAutoPicks(), 1);

  const pick = get('SELECT * FROM picks WHERE entry_id = ? AND round_number = 1', entry.id);
  assert.equal(pick.needs_reselect, 0);
  assert.equal(pick.auto_assigned, 1);
  assert.equal(pick.outcome, 'pending');
  assert.notEqual(pick.team_id, picked, 'never the club whose game was called off');

  // It is the first unused club alphabetically that actually has a game on.
  const playing = new Set(fixtures.filter((f) => f.status !== 'postponed')
    .flatMap((f) => [f.home_team_id, f.away_team_id]));
  const expected = all('SELECT * FROM teams WHERE season_id = ? ORDER BY name', season.seasonId)
    .find((team) => playing.has(team.id));
  assert.equal(pick.team_id, expected.id);

  const notice = get(
    "SELECT * FROM notifications WHERE kind = 'auto_pick' AND league_id = ? ORDER BY id DESC", league.id,
  );
  assert.match(notice.body, /called off/i, 'the notice says why they were given a club');

  // And it does not fire twice.
  assert.equal(applyAutoPicks(), 0);
});
