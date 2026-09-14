import { all, get } from '../db/index.js';
import {
  cycleForRound, decideWinners, fixtureOutcome, gameweekForRound, nextAlphabeticalTeam,
  resultForOutcome,
} from '../domain/rules.js';
import { leagueContext, policiesFor } from './leagues.js';

/**
 * An independent second opinion on every result in a league.
 *
 * Deliberately uncached: a stale answer would defeat the point, and checking a
 * 10,000-pick league from scratch takes well under a tenth of a second.
 *
 * Settlement decides outcomes one pick at a time, looking up a single fixture.
 * This pass does the opposite: it loads every team, gameweek, fixture, entry
 * and pick for the league and recomputes each result from scratch, then
 * compares that against what was actually recorded. Anything that disagrees is
 * reported rather than quietly corrected — a mismatch means either the data
 * moved (a score was amended) or something is wrong, and both deserve a human.
 */

const SEVERITY = { error: 'error', warning: 'warning' };

function issue(list, severity, code, detail, extra = {}) {
  list.push({ severity, code, detail, ...extra });
}

/**
 * Find a team's fixture by scanning the whole gameweek rather than trusting a
 * single lookup, so a duplicated or missing fixture shows up instead of
 * silently deciding somebody's fate.
 */
export function resolveFixture(fixtures, teamId) {
  const matches = fixtures.filter(
    (fixture) => fixture.home_team_id === teamId || fixture.away_team_id === teamId,
  );
  if (matches.length === 1) return { fixture: matches[0], ambiguous: false, count: 1 };
  return { fixture: matches[0] ?? null, ambiguous: matches.length > 1, count: matches.length };
}

export function verifyLeague(leagueId) {
  const league = get('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!league) return { ok: false, issues: [{ severity: SEVERITY.error, code: 'league_missing', detail: 'League not found' }] };

  const context = leagueContext(league);
  const policies = policiesFor(league);
  const issues = [];

  const teamIds = new Set(context.teams.map((team) => team.id));
  const entries = all(
    `SELECT e.*, u.display_name FROM entries e JOIN users u ON u.id = e.user_id WHERE e.league_id = ?`,
    league.id,
  );
  const picks = all(
    `SELECT p.*, g.number AS gameweek_number, t.name AS team_name
     FROM picks p
     JOIN gameweeks g ON g.id = p.gameweek_id
     LEFT JOIN teams t ON t.id = p.team_id
     WHERE p.league_id = ?
     ORDER BY p.entry_id, p.round_number`,
    league.id,
  );

  // Fixtures, loaded once per gameweek and reused for every pick in it.
  const fixturesByGameweek = new Map();
  for (const roundInfo of context.rounds) {
    fixturesByGameweek.set(roundInfo.gameweek.id, roundInfo.fixtures);
  }

  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const picksByEntry = new Map();
  for (const pick of picks) {
    if (!picksByEntry.has(pick.entry_id)) picksByEntry.set(pick.entry_id, []);
    picksByEntry.get(pick.entry_id).push(pick);
  }

  let checkedPicks = 0;

  // A finished league stops being judged. Picks banked for rounds beyond the
  // one that decided it are moot, not wrong.
  const leagueFinished = league.status === 'completed' || league.status === 'archived';
  const lastJudgedRound = picks.reduce(
    (max, pick) => (pick.result === 'pending' ? max : Math.max(max, pick.round_number)), 0,
  );
  // Only cap once something has actually been judged: a finished league with no
  // settled picks at all is a problem in itself, and still needs checking.
  const judgedThrough = leagueFinished && lastJudgedRound > 0 ? lastJudgedRound : Infinity;

  // ----------------------------------------------------------- every pick --
  for (const pick of picks) {
    const entry = entryById.get(pick.entry_id);
    const where = {
      round: pick.round_number,
      entryId: pick.entry_id,
      entryName: entry?.display_name ?? `entry ${pick.entry_id}`,
      team: pick.team_name,
    };

    if (!entry) {
      issue(issues, SEVERITY.error, 'orphan_pick', 'A pick belongs to an entry that no longer exists', where);
      continue;
    }
    if (!pick.team_name || !teamIds.has(pick.team_id)) {
      issue(issues, SEVERITY.error, 'team_not_in_season',
        'The picked club is not in this league\'s season', where);
      continue;
    }

    // The round, gameweek and cycle must agree with the league's start point.
    const expectedGameweek = gameweekForRound(league.start_gameweek, pick.round_number);
    if (pick.gameweek_number !== expectedGameweek) {
      issue(issues, SEVERITY.error, 'round_gameweek_mismatch',
        `Round ${pick.round_number} should be gameweek ${expectedGameweek}, not ${pick.gameweek_number}`, where);
    }
    const expectedCycle = cycleForRound(pick.round_number, context.teamCount || 1);
    if (pick.cycle !== expectedCycle) {
      issue(issues, SEVERITY.error, 'cycle_mismatch',
        `Round ${pick.round_number} belongs to cycle ${expectedCycle}, recorded as ${pick.cycle}`, where);
    }

    if (pick.round_number > judgedThrough) continue; // played out after the league was won

    // A pick banked for a later round by someone who then went out is never
    // judged, and should not be. Only the round that ended their run counts.
    const spentRound = entry.status === 'eliminated' ? entry.eliminated_round : null;
    if (entry.status === 'withdrawn' || (spentRound != null && pick.round_number > spentRound)) {
      if (pick.result !== 'pending') {
        issue(issues, SEVERITY.error, 'judged_after_exit',
          `Round ${pick.round_number} was judged even though they were already out in round ${spentRound}`,
          where);
      }
      continue;
    }

    const roundInfo = context.roundInfo(pick.round_number);
    const fixtures = fixturesByGameweek.get(pick.gameweek_id) ?? [];
    const resolution = resolveFixture(fixtures, pick.team_id);
    if (resolution.ambiguous) {
      issue(issues, SEVERITY.error, 'duplicate_fixture',
        `${pick.team_name} appears in ${resolution.count} fixtures in gameweek ${pick.gameweek_number}`, where);
      continue;
    }

    // Recompute from the fixture rather than trusting the stored outcome.
    const expectedOutcome = fixtureOutcome(resolution.fixture, pick.team_id);
    const roundComplete = Boolean(roundInfo?.settled);
    const expectedResult = resultForOutcome(expectedOutcome, policies, {
      canReselect: !roundComplete && Boolean(pick.needs_reselect),
    });
    checkedPicks += 1;

    if (roundComplete) {
      // The round is over, so the recorded outcome and result must both match
      // what the fixtures and the league's rules produce.
      if (pick.outcome !== expectedOutcome) {
        issue(issues, SEVERITY.error, 'outcome_mismatch',
          `Recorded as "${pick.outcome}" but the fixture says "${expectedOutcome}"`,
          { ...where, recorded: pick.outcome, expected: expectedOutcome });
      }
      if (pick.result !== expectedResult) {
        issue(issues, SEVERITY.error, 'result_mismatch',
          `Recorded as "${pick.result}" but the rules give "${expectedResult}"`,
          { ...where, recorded: pick.result, expected: expectedResult });
      }
    } else {
      // Mid-round, "pending" is the normal state: nothing is judged until every
      // fixture in the gameweek is done. The only legitimate exception is a
      // pick voided by a called-off game, which opens a reselection at once.
      const awaitingReselection = pick.outcome === 'void' && pick.needs_reselect;
      if (pick.outcome !== 'pending' && !awaitingReselection && pick.outcome !== expectedOutcome) {
        issue(issues, SEVERITY.error, 'stale_outcome',
          `Round ${pick.round_number} is still in play but the pick already reads "${pick.outcome}"`,
          { ...where, recorded: pick.outcome, expected: expectedOutcome });
      }
      if (pick.result !== 'pending') {
        issue(issues, SEVERITY.error, 'settled_early',
          `Round ${pick.round_number} still has fixtures to play but the pick is already marked "${pick.result}"`,
          where);
      }
    }
  }

  // -------------------------------------------- one club per cycle, per entry --
  for (const [entryId, entryPicks] of picksByEntry) {
    const seen = new Map();
    for (const pick of entryPicks) {
      if (pick.outcome === 'void') continue; // a called-off game frees the club
      const key = `${pick.cycle}:${pick.team_id}`;
      if (seen.has(key)) {
        issue(issues, SEVERITY.error, 'team_reused',
          `${pick.team_name} was used in rounds ${seen.get(key)} and ${pick.round_number} of the same cycle`,
          { entryId, entryName: entryById.get(entryId)?.display_name, round: pick.round_number });
      }
      seen.set(key, pick.round_number);
    }
  }

  // ------------------------------------------- entries: in, out and why -----
  const settledRounds = context.rounds.filter((roundInfo) => roundInfo.settled).map((roundInfo) => roundInfo.round);
  const lastSettled = settledRounds.length ? Math.max(...settledRounds) : 0;
  const roundByNumber = new Map(context.rounds.map((roundInfo) => [roundInfo.round, roundInfo]));

  /**
   * Would the missed-deadline rule have had anything to hand this entry? If
   * every club is spent, or none of the ones left had a game on, then no pick
   * is the right answer rather than a hole in the records.
   */
  const assignableTeam = (entry, round) => {
    const roundInfo = roundByNumber.get(round);
    if (!roundInfo) return null;
    const playable = new Set();
    for (const fixture of roundInfo.fixtures) {
      if (fixture.status === 'postponed' || fixture.status === 'abandoned') continue;
      playable.add(fixture.home_team_id);
      playable.add(fixture.away_team_id);
    }
    return nextAlphabeticalTeam(
      context.teams, picksByEntry.get(entry.id) ?? [], round, context.teamCount || 1,
      (teamId) => playable.has(teamId),
    );
  };

  for (const entry of entries) {
    if (entry.status === 'withdrawn') continue;
    const entryPicks = picksByEntry.get(entry.id) ?? [];
    const byRound = new Map(entryPicks.map((pick) => [pick.round_number, pick]));
    const firstFatal = entryPicks
      .filter((pick) => pick.result === 'eliminated')
      .sort((a, b) => a.round_number - b.round_number)[0] ?? null;

    if (entry.status === 'active') {
      if (firstFatal) {
        issue(issues, SEVERITY.error, 'still_in_after_losing',
          `Still marked as in, but their round ${firstFatal.round_number} pick (${firstFatal.team_name}) lost`,
          { entryId: entry.id, entryName: entry.display_name, round: firstFatal.round_number });
      }
      // Every round that has already been played needs a pick behind it.
      for (const round of settledRounds) {
        if (round > judgedThrough) continue; // the league was already decided
        if (byRound.has(round)) continue;
        if (entry.reinstated_at) continue; // reinstated part way through
        if (policies.noPickPolicy === 'auto_alphabetical' && !assignableTeam(entry, round)) continue;
        issue(issues, SEVERITY.error, 'missing_pick',
          `No pick recorded for settled round ${round}, yet they are still in`,
          { entryId: entry.id, entryName: entry.display_name, round });
      }
    }

    if (entry.status === 'eliminated') {
      if (entry.eliminated_round == null) {
        issue(issues, SEVERITY.error, 'elimination_without_round',
          'Marked as out with no round recorded', { entryId: entry.id, entryName: entry.display_name });
        continue;
      }
      const cause = byRound.get(entry.eliminated_round);
      const noPickCause = !cause && policies.noPickPolicy === 'eliminate';
      const adminCause = ['admin', 'no_pick'].includes(entry.eliminated_reason);

      if (!cause && !noPickCause && !adminCause) {
        issue(issues, SEVERITY.error, 'elimination_without_cause',
          `Out in round ${entry.eliminated_round} but there is no losing pick to explain it`,
          { entryId: entry.id, entryName: entry.display_name, round: entry.eliminated_round });
      } else if (cause && cause.result === 'survived') {
        issue(issues, SEVERITY.error, 'eliminated_on_a_win',
          `Out in round ${entry.eliminated_round} although ${cause.team_name} went through`,
          { entryId: entry.id, entryName: entry.display_name, round: entry.eliminated_round });
      }
      if (firstFatal && firstFatal.round_number < entry.eliminated_round) {
        issue(issues, SEVERITY.warning, 'elimination_round_late',
          `Recorded as out in round ${entry.eliminated_round}, but their first losing pick was round ${firstFatal.round_number}`,
          { entryId: entry.id, entryName: entry.display_name, round: entry.eliminated_round });
      }
    }
  }

  // --------------------------------------------------------- the winners ----
  const contenders = entries.filter((entry) => entry.status !== 'withdrawn');
  if (lastSettled > 0 && contenders.length) {
    const verdict = decideWinners(contenders, lastSettled);
    const recorded = contenders.filter((entry) => entry.is_winner).map((entry) => entry.id).sort();
    const expected = [...verdict.winnerIds].sort();
    if (JSON.stringify(recorded) !== JSON.stringify(expected)) {
      issue(issues, SEVERITY.error, 'winner_mismatch',
        `Winners recorded as [${recorded.join(', ') || 'none'}] but the field gives [${expected.join(', ') || 'none'}]`,
        { round: lastSettled, recorded, expected });
    }
    if (verdict.complete && league.status !== 'completed' && league.status !== 'archived') {
      issue(issues, SEVERITY.warning, 'league_not_closed',
        'The competition has a winner but the league is still marked as running', {});
    }
    if (!verdict.complete && league.status === 'completed') {
      issue(issues, SEVERITY.error, 'league_closed_early',
        `The league is marked complete with ${contenders.filter((entry) => entry.status === 'active').length} entrants still in`,
        {});
    }
  }

  const errors = issues.filter((entry) => entry.severity === SEVERITY.error);
  return {
    leagueId: league.id,
    leagueName: league.name,
    checkedAt: new Date().toISOString(),
    entriesChecked: entries.length,
    picksChecked: checkedPicks,
    roundsSettled: settledRounds.length,
    issues,
    errorCount: errors.length,
    warningCount: issues.length - errors.length,
    ok: errors.length === 0,
  };
}

export function verifyAllLeagues() {
  return all("SELECT id FROM leagues WHERE status != 'archived' ORDER BY id")
    .map((league) => verifyLeague(league.id));
}
