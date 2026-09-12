import { all, get, run, audit, transaction } from '../db/index.js';
import { nowIso } from '../lib/time.js';
import { decideWinners, settlePick } from '../domain/rules.js';
import { gameweekForLeagueRound, leagueContext, policiesFor } from './leagues.js';
import { fixtureForTeam } from './picks.js';
import { queueEliminationNotices, queueSurvivalNotices, queueWinnerNotices } from './notifications.js';

/**
 * Settle one round of one league. Safe to run repeatedly: a round is only
 * settled once every fixture in it has finished (or been called off), and
 * already-settled picks are left alone.
 *
 * @returns {{settled:boolean, reason?:string, eliminated?:number, survived?:number}}
 */
export function settleRound(leagueId, round, { actorUserId = null, force = false } = {}) {
  const league = get('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!league) return { settled: false, reason: 'league_missing' };
  if (league.status === 'archived') return { settled: false, reason: 'archived' };

  const context = leagueContext(league);
  const roundInfo = context.roundInfo(round);
  if (!roundInfo) return { settled: false, reason: 'no_such_round' };
  if (!roundInfo.deadlinePassed) return { settled: false, reason: 'deadline_not_passed' };
  if (!roundInfo.settled && !force) return { settled: false, reason: 'fixtures_in_progress' };

  const gameweek = gameweekForLeagueRound(league, round);
  const policies = policiesFor(league);

  return transaction(() => {
    const entries = all('SELECT * FROM entries WHERE league_id = ? AND status = \'active\'', league.id);
    const eliminated = [];
    const survived = [];

    for (const entry of entries) {
      const pick = get('SELECT * FROM picks WHERE entry_id = ? AND gameweek_id = ?', entry.id, gameweek.id);

      if (!pick) {
        // No pick before the deadline.
        if (policies.noPickPolicy === 'random') continue; // auto-picks are made by the scheduler at the deadline
        eliminateEntry(entry, round, 'no_pick');
        eliminated.push({ entry, reason: 'no_pick', teamName: null });
        continue;
      }

      const fixture = fixtureForTeam(gameweek.id, pick.team_id);
      const { outcome, result } = settlePick(fixture, pick.team_id, policies);
      if (result === 'pending') continue;

      run('UPDATE picks SET outcome = ?, result = ?, updated_at = ? WHERE id = ?',
        outcome, result, nowIso(), pick.id);

      const team = get('SELECT name FROM teams WHERE id = ?', pick.team_id);
      if (result === 'eliminated') {
        eliminateEntry(entry, round, outcome);
        eliminated.push({ entry, reason: outcome, teamName: team?.name ?? null });
      } else {
        survived.push({ entry, teamName: team?.name ?? null });
      }
    }

    const after = all('SELECT * FROM entries WHERE league_id = ?', league.id);
    const verdict = decideWinners(after.filter((entry) => entry.status !== 'withdrawn'), round);

    if (verdict.complete) {
      for (const winnerId of verdict.winnerIds) {
        run('UPDATE entries SET is_winner = 1 WHERE id = ?', winnerId);
      }
      run('UPDATE leagues SET status = \'completed\', completed_at = ? WHERE id = ?', nowIso(), league.id);
      queueWinnerNotices(league, verdict.winnerIds, round, verdict.reason);
    } else if (league.status === 'open' || league.status === 'active') {
      run('UPDATE leagues SET status = \'active\' WHERE id = ?', league.id);
    }

    queueEliminationNotices(league, eliminated, round);
    queueSurvivalNotices(league, survived, round, verdict.complete);
    audit(actorUserId, 'league.settle_round', 'league', league.id, {
      round, eliminated: eliminated.length, survived: survived.length, complete: verdict.complete,
    });

    return {
      settled: true,
      round,
      eliminated: eliminated.length,
      survived: survived.length,
      complete: verdict.complete,
      winnerIds: verdict.winnerIds,
    };
  });
}

function eliminateEntry(entry, round, reason) {
  run(
    `UPDATE entries SET status = 'eliminated', eliminated_round = ?, eliminated_reason = ?, eliminated_at = ?
     WHERE id = ? AND status = 'active'`,
    round, reason, nowIso(), entry.id,
  );
}

/** Settle every round that is ready, across every live league. */
export function settleAllLeagues({ actorUserId = null } = {}) {
  const leagues = all('SELECT * FROM leagues WHERE status IN (\'open\', \'active\')');
  const results = [];
  for (const league of leagues) {
    const context = leagueContext(league);
    for (const roundInfo of context.rounds) {
      if (!roundInfo.settled) break; // rounds settle in order
      const alreadyDone = get(
        `SELECT COUNT(*) AS pending FROM picks
         WHERE league_id = ? AND round_number = ? AND result = 'pending'`,
        league.id, roundInfo.round,
      ).pending === 0;
      const noPickStragglers = get(
        `SELECT COUNT(*) AS count FROM entries e
         WHERE e.league_id = ? AND e.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM picks p WHERE p.entry_id = e.id AND p.round_number = ?)`,
        league.id, roundInfo.round,
      ).count;
      if (alreadyDone && noPickStragglers === 0) continue;
      const outcome = settleRound(league.id, roundInfo.round, { actorUserId });
      if (outcome.settled) results.push({ leagueId: league.id, ...outcome });
      if (outcome.settled && outcome.complete) break;
    }
  }
  return results;
}

/**
 * Recompute a league from scratch — the super admin's escape hatch after a
 * result is corrected. Clears settlement state and replays every round.
 */
export function recomputeLeague(leagueId, { actorUserId = null } = {}) {
  transaction(() => {
    run('UPDATE picks SET outcome = \'pending\', result = \'pending\' WHERE league_id = ?', leagueId);
    run(
      `UPDATE entries SET status = 'active', eliminated_round = NULL, eliminated_reason = NULL,
              eliminated_at = NULL, is_winner = 0
       WHERE league_id = ? AND status != 'withdrawn'`,
      leagueId,
    );
    run('UPDATE leagues SET status = \'active\', completed_at = NULL WHERE id = ? AND status != \'archived\'', leagueId);
  });

  const league = get('SELECT * FROM leagues WHERE id = ?', leagueId);
  const context = leagueContext(league);
  const results = [];
  for (const roundInfo of context.rounds) {
    if (!roundInfo.settled) break;
    const outcome = settleRound(leagueId, roundInfo.round, { actorUserId });
    if (outcome.settled) results.push(outcome);
    if (outcome.complete) break;
  }
  audit(actorUserId, 'league.recompute', 'league', leagueId, { rounds: results.length });
  return results;
}
