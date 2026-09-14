import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-verify-'));
process.env.DATABASE_FILE = path.join(tmp, 'test.sqlite');
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';

const { all, get, run } = await import('../src/db/index.js');
const { seedSeason } = await import('../src/db/seed.js');
const { createLeague, joinLeague } = await import('../src/services/leagues.js');
const { submitPick } = await import('../src/services/picks.js');
const { recomputeLeague, settleRound } = await import('../src/services/settlement.js');
const { verifyLeague } = await import('../src/services/verification.js');

const season = seedSeason({
  seasonName: 'verify-season',
  startDate: new Date('2025-08-16T00:00:00.000Z'),
  reset: true,
});

const teams = () => all('SELECT * FROM teams WHERE season_id = ? ORDER BY id', season.seasonId);
const gameweek = (number) =>
  get('SELECT * FROM gameweeks WHERE season_id = ? AND number = ?', season.seasonId, number);

let counter = 0;
function makeUser(name) {
  counter += 1;
  const result = run(
    `INSERT INTO users (email, display_name, password_hash, created_at) VALUES (?, ?, 'x', datetime('now'))`,
    `${name}-${counter}@example.com`, name,
  );
  return get('SELECT * FROM users WHERE id = ?', Number(result.lastInsertRowid));
}

/** A settled round: two entrants, one wins, one loses. */
function playedLeague(name, startGameweek) {
  const league = createLeague({
    launched: true,
    name, seasonId: season.seasonId, startGameweek, createdBy: makeUser('owner').id,
  });
  const pool = teams();
  const winner = joinLeague(league, makeUser('winner').id, { force: true });
  const loser = joinLeague(league, makeUser('loser').id, { force: true });
  submitPick({ league, entry: winner, round: 1, teamId: pool[0].id, actorUserId: null, override: true });
  submitPick({ league, entry: loser, round: 1, teamId: pool[2].id, actorUserId: null, override: true });

  const week = gameweek(startGameweek);
  for (const [teamId, outcome] of [[pool[0].id, 'win'], [pool[2].id, 'loss']]) {
    const fixture = get(
      'SELECT * FROM fixtures WHERE gameweek_id = ? AND (home_team_id = ? OR away_team_id = ?)',
      week.id, teamId, teamId,
    );
    const home = fixture.home_team_id === teamId;
    const [forTeam, against] = outcome === 'win' ? [2, 0] : [0, 2];
    run("UPDATE fixtures SET status = 'finished', home_score = ?, away_score = ? WHERE id = ?",
      home ? forTeam : against, home ? against : forTeam, fixture.id);
  }
  run(
    `UPDATE fixtures SET status = 'finished', home_score = COALESCE(home_score, 0),
            away_score = COALESCE(away_score, 0) WHERE gameweek_id = ?`,
    week.id,
  );
  settleRound(league.id, 1);
  return { league, winner, loser, pool, week };
}

test('a correctly settled league passes the cross-check', () => {
  const { league, winner, loser } = playedLeague('Clean', 1);
  assert.equal(get('SELECT status FROM entries WHERE id = ?', loser.id).status, 'eliminated');
  assert.equal(get('SELECT status FROM entries WHERE id = ?', winner.id).status, 'active');

  const report = verifyLeague(league.id);
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.equal(report.errorCount, 0);
  assert.equal(report.picksChecked, 2);
  assert.equal(report.roundsSettled, 1);
});

test('settlement returns its own verification verdict', () => {
  const { league } = playedLeague('Self checking', 2);
  const again = settleRound(league.id, 1, { force: true });
  assert.equal(again.verification.ok, true);
  assert.equal(again.verification.errors, 0);
});

test('a result quietly changed in the database is caught', () => {
  const { league, loser } = playedLeague('Tampered', 3);
  // Flip a losing pick to a win without touching the fixture.
  run("UPDATE picks SET outcome = 'win', result = 'survived' WHERE entry_id = ?", loser.id);
  run("UPDATE entries SET status = 'active', eliminated_round = NULL, eliminated_reason = NULL WHERE id = ?", loser.id);

  const report = verifyLeague(league.id);
  assert.equal(report.ok, false);
  const codes = report.issues.map((issue) => issue.code);
  assert.ok(codes.includes('outcome_mismatch'), JSON.stringify(codes));
  assert.ok(codes.includes('result_mismatch'));
  const detail = report.issues.find((issue) => issue.code === 'outcome_mismatch');
  assert.equal(detail.expected, 'loss');
  assert.equal(detail.recorded, 'win');
  assert.ok(detail.entryName);
});

test('someone knocked out with nothing to explain it is caught', () => {
  const { league, winner } = playedLeague('Wrongly out', 4);
  run(
    `UPDATE entries SET status = 'eliminated', eliminated_round = 1, eliminated_reason = 'loss' WHERE id = ?`,
    winner.id,
  );

  const codes = verifyLeague(league.id).issues.map((issue) => issue.code);
  assert.ok(codes.includes('eliminated_on_a_win'), JSON.stringify(codes));
});

test('someone still in after a losing pick is caught', () => {
  const { league, loser } = playedLeague('Wrongly in', 5);
  run("UPDATE entries SET status = 'active', eliminated_round = NULL WHERE id = ?", loser.id);

  const report = verifyLeague(league.id);
  const codes = report.issues.map((issue) => issue.code);
  assert.ok(codes.includes('still_in_after_losing'), JSON.stringify(codes));
  assert.ok(codes.includes('winner_mismatch'), 'and the winner list no longer adds up');
});

test('the same club used twice in a cycle is caught', () => {
  const league = createLeague({
    launched: true,
    name: 'Double dip', seasonId: season.seasonId, startGameweek: 10, createdBy: makeUser('owner').id,
  });
  const entry = joinLeague(league, makeUser('cheat').id, { force: true });
  const pool = teams();
  submitPick({ league, entry, round: 1, teamId: pool[0].id, actorUserId: null, override: true });
  submitPick({ league, entry, round: 2, teamId: pool[1].id, actorUserId: null, override: true });
  // The database index normally makes this impossible, so drop it to stand in
  // for data that arrived some other way — a hand edit, or an older import.
  run('DROP INDEX idx_picks_team_per_cycle');
  run('UPDATE picks SET team_id = ? WHERE entry_id = ? AND round_number = 2', pool[0].id, entry.id);

  const codes = verifyLeague(league.id).issues.map((issue) => issue.code);
  assert.ok(codes.includes('team_reused'), JSON.stringify(codes));

  // Clear the impossible row before restoring the index it would violate.
  run('DELETE FROM picks WHERE entry_id = ? AND round_number = 2', entry.id);
  run(`CREATE UNIQUE INDEX idx_picks_team_per_cycle
       ON picks(entry_id, cycle, team_id) WHERE outcome != 'void'`);
});

test('the database itself refuses to reuse a club inside a cycle', () => {
  const league = createLeague({
    launched: true,
    name: 'Belt and braces', seasonId: season.seasonId, startGameweek: 11, createdBy: makeUser('owner').id,
  });
  const entry = joinLeague(league, makeUser('persistent').id, { force: true });
  const pool = teams();
  submitPick({ league, entry, round: 1, teamId: pool[0].id, actorUserId: null, override: true });
  submitPick({ league, entry, round: 2, teamId: pool[1].id, actorUserId: null, override: true });

  assert.throws(
    () => run('UPDATE picks SET team_id = ? WHERE entry_id = ? AND round_number = 2', pool[0].id, entry.id),
    /UNIQUE constraint failed/,
  );
});

test('a pick filed against the wrong gameweek is caught', () => {
  const league = createLeague({
    launched: true,
    name: 'Wrong week', seasonId: season.seasonId, startGameweek: 12, createdBy: makeUser('owner').id,
  });
  const entry = joinLeague(league, makeUser('muddled').id, { force: true });
  submitPick({ league, entry, round: 1, teamId: teams()[0].id, actorUserId: null, override: true });
  run('UPDATE picks SET gameweek_id = ? WHERE entry_id = ?', gameweek(20).id, entry.id);

  const codes = verifyLeague(league.id).issues.map((issue) => issue.code);
  assert.ok(codes.includes('round_gameweek_mismatch'), JSON.stringify(codes));
});

test('a club with two fixtures in one gameweek stops the round being settled', () => {
  const league = createLeague({
    launched: true,
    name: 'Fixture chaos', seasonId: season.seasonId, startGameweek: 14, createdBy: makeUser('owner').id,
  });
  const entry = joinLeague(league, makeUser('unlucky').id, { force: true });
  const pool = teams();
  submitPick({ league, entry, round: 1, teamId: pool[0].id, actorUserId: null, override: true });

  const week = gameweek(14);
  run(
    `UPDATE fixtures SET status = 'finished', home_score = 0, away_score = 3 WHERE gameweek_id = ?`, week.id,
  );
  // A duplicate fixture for the same club: the data is wrong, not the entrant.
  run(
    `INSERT INTO fixtures (gameweek_id, home_team_id, away_team_id, kickoff, status, home_score, away_score, external_ref, updated_at)
     VALUES (?, ?, ?, ?, 'finished', 1, 0, 'duplicate-test', datetime('now'))`,
    week.id, pool[0].id, pool[5].id, new Date('2025-11-01T15:00:00Z').toISOString(),
  );

  const result = settleRound(league.id, 1, { force: true });
  assert.equal(get('SELECT status FROM entries WHERE id = ?', entry.id).status, 'active',
    'nobody is knocked out on ambiguous data');
  assert.equal(result.verification.ok, false);

  const codes = verifyLeague(league.id).issues.map((issue) => issue.code);
  assert.ok(codes.includes('duplicate_fixture'), JSON.stringify(codes));
});

test('a failed check tells the super admin and never rewrites the results itself', () => {
  run(
    `INSERT INTO users (email, display_name, password_hash, is_super_admin, created_at)
     VALUES ('boss-verify@example.com', 'Boss', 'x', 1, datetime('now'))`,
  );
  const { league, loser } = playedLeague('Alarm', 15);
  run("UPDATE picks SET outcome = 'win', result = 'survived' WHERE entry_id = ?", loser.id);

  const result = settleRound(league.id, 1, { force: true });
  assert.equal(result.verification.ok, false);

  // The bad data is reported, not silently overwritten.
  const notice = get(
    `SELECT * FROM notifications WHERE kind = 'verification_failed' AND league_id = ? ORDER BY id DESC`,
    league.id,
  );
  assert.ok(notice, 'the platform admin is told');
  assert.match(notice.subject, /need checking/i);
  const logged = get(
    `SELECT * FROM audit_log WHERE action = 'league.verification_failed' AND entity_id = ?`, league.id,
  );
  assert.ok(logged);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('replaying a league does not raise false alarms along the way', () => {
  const { league } = playedLeague('Replay', 20);
  // A second settled round so the replay has to walk through more than one.
  const pool = teams();
  const entry = all("SELECT * FROM entries WHERE league_id = ? AND status = 'active'", league.id)[0];
  submitPick({ league, entry, round: 2, teamId: pool[4].id, actorUserId: null, override: true });
  run(
    `UPDATE fixtures SET status = 'finished', home_score = COALESCE(home_score, 0),
            away_score = COALESCE(away_score, 0) WHERE gameweek_id = ?`,
    gameweek(21).id,
  );

  const before = get(
    "SELECT COUNT(*) AS count FROM audit_log WHERE action = 'league.verification_failed' AND entity_id = ?",
    league.id,
  ).count;

  recomputeLeague(league.id);

  const after = get(
    "SELECT COUNT(*) AS count FROM audit_log WHERE action = 'league.verification_failed' AND entity_id = ?",
    league.id,
  ).count;
  assert.equal(after, before, 'no mid-replay complaints about rounds not yet replayed');
  assert.equal(verifyLeague(league.id).ok, true);
});

test('a pick banked for later by someone who then went out is left alone', () => {
  const { league, loser, pool } = playedLeague('Banked ahead', 30);

  // They had already chosen for a later round before their run ended.
  submitPick({ league, entry: loser, round: 4, teamId: pool[8].id, actorUserId: null, override: true });
  assert.equal(get('SELECT status FROM entries WHERE id = ?', loser.id).status, 'eliminated');

  // Round 4 is played out. Their pick stays pending, because they were not in it.
  run(
    `UPDATE fixtures SET status = 'finished', home_score = 3, away_score = 0
     WHERE gameweek_id = (SELECT id FROM gameweeks WHERE season_id = ? AND number = 33)`,
    season.seasonId,
  );
  settleRound(league.id, 4, { force: true });

  const banked = get('SELECT * FROM picks WHERE entry_id = ? AND round_number = 4', loser.id);
  assert.equal(banked.result, 'pending', 'never judged');
  const report = verifyLeague(league.id);
  assert.equal(report.ok, true, JSON.stringify(report.issues));

  // But judging it would be wrong, and the check says so.
  run("UPDATE picks SET outcome = 'win', result = 'survived' WHERE id = ?", banked.id);
  assert.ok(verifyLeague(league.id).issues.some((entry) => entry.code === 'judged_after_exit'));
});
