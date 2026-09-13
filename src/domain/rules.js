/**
 * Pure Last Man Standing rules. No database access here so the rules can be
 * unit tested in isolation — see test/rules.test.js.
 *
 * Vocabulary:
 *   gameweek  - a Premier League gameweek number (1..38)
 *   round     - a competition round, 1-based from the league's start gameweek
 *   cycle     - which pass through the 20 teams a round belongs to. Every team
 *               is selectable again once a cycle completes, so with 20 teams
 *               round 21 opens all 20 teams up again.
 */

export const DEFAULT_POLICIES = Object.freeze({
  // A draw is not a win, so by default it knocks you out.
  drawPolicy: 'eliminate',
  // Postponed/abandoned, or no fixture at all. 'reselect' asks the entrant for
  // a new pick instead of punishing them for a game being called off.
  voidPolicy: 'reselect',
  // Missing a deadline hands you the next club you have not used, alphabetically.
  noPickPolicy: 'auto_alphabetical',
});

export function roundForGameweek(startGameweek, gameweekNumber) {
  return gameweekNumber - startGameweek + 1;
}

export function gameweekForRound(startGameweek, round) {
  return startGameweek + round - 1;
}

/** Rounds 1..20 are cycle 0, 21..40 are cycle 1, and so on. */
export function cycleForRound(round, teamCount) {
  if (!Number.isInteger(round) || round < 1) throw new Error(`Invalid round: ${round}`);
  if (!Number.isInteger(teamCount) || teamCount < 1) throw new Error(`Invalid team count: ${teamCount}`);
  return Math.floor((round - 1) / teamCount);
}

/**
 * Teams an entry may still pick in a given round: everything not already used
 * in the same cycle. A pick voided by a called-off fixture does not count as
 * used — that club never actually played for them.
 * @param {Array<{id:number}>} teams every team in the competition
 * @param {Array<{team_id:number, cycle:number, outcome?:string}>} picks the entry's picks so far
 */
export function availableTeams(teams, picks, round, teamCount) {
  const used = usedTeamIds(picks, round, teamCount);
  return teams.filter((team) => !used.has(team.id));
}

export function usedTeamIds(picks, round, teamCount) {
  const cycle = cycleForRound(round, teamCount);
  return new Set(
    picks
      .filter((pick) => pick.cycle === cycle && pick.outcome !== 'void')
      .map((pick) => pick.team_id),
  );
}

/**
 * The club handed to someone who missed the deadline: the first one they have
 * not used yet, in alphabetical order, that actually has a fixture.
 * @param {Array<{id:number, name:string}>} teams
 * @param {(teamId:number) => boolean} playsInRound
 */
export function nextAlphabeticalTeam(teams, picks, round, teamCount, playsInRound = () => true) {
  const used = usedTeamIds(picks, round, teamCount);
  return [...teams]
    .sort((a, b) => a.name.localeCompare(b.name, 'en-GB'))
    .find((team) => !used.has(team.id) && playsInRound(team.id)) ?? null;
}

/**
 * Outcome of one fixture for the team that was picked.
 * @param {{status:string, home_team_id:number, away_team_id:number, home_score:?number, away_score:?number}|null} fixture
 * @returns {'pending'|'win'|'draw'|'loss'|'void'}
 */
export function fixtureOutcome(fixture, teamId) {
  if (!fixture) return 'void'; // blank gameweek — the team has no match
  if (fixture.status === 'postponed' || fixture.status === 'abandoned') return 'void';
  if (fixture.status !== 'finished') return 'pending';
  if (fixture.home_score == null || fixture.away_score == null) return 'pending';

  const isHome = fixture.home_team_id === teamId;
  const isAway = fixture.away_team_id === teamId;
  if (!isHome && !isAway) throw new Error(`Team ${teamId} does not play in fixture ${fixture.id}`);

  const scored = isHome ? fixture.home_score : fixture.away_score;
  const conceded = isHome ? fixture.away_score : fixture.home_score;
  if (scored > conceded) return 'win';
  if (scored < conceded) return 'loss';
  return 'draw';
}

/**
 * Turn an outcome into survival, applying the league's policies.
 *
 * Under the default `reselect` void policy a called-off fixture leaves the
 * round unresolved while the entrant still has time to choose again; once no
 * other fixture in the round is left to pick from, they survive.
 *
 * @param {{canReselect?:boolean}} [context]
 * @returns {'pending'|'survived'|'eliminated'}
 */
export function resultForOutcome(outcome, policies = DEFAULT_POLICIES, { canReselect = false } = {}) {
  switch (outcome) {
    case 'pending': return 'pending';
    case 'win': return 'survived';
    case 'loss': return 'eliminated';
    case 'draw': return policies.drawPolicy === 'survive' ? 'survived' : 'eliminated';
    case 'void':
      if (policies.voidPolicy === 'survive') return 'survived';
      if (policies.voidPolicy === 'reselect') return canReselect ? 'pending' : 'survived';
      return 'eliminated';
    default: throw new Error(`Unknown outcome: ${outcome}`);
  }
}

/** Convenience: fixture -> final result in one step. */
export function settlePick(fixture, teamId, policies = DEFAULT_POLICIES, context = {}) {
  const outcome = fixtureOutcome(fixture, teamId);
  return { outcome, result: resultForOutcome(outcome, policies, context) };
}

/**
 * Validate a proposed pick before it is written.
 * @returns {{ok:true}|{ok:false, code:string, message:string}}
 */
export function validatePick({
  entryStatus,
  leagueStatus,
  round,
  teamCount,
  usedPicks,
  teamId,
  teamPlaysInRound,
  deadlinePassed,
  entryDeadlinePassed,
  initialPicks,
  // True when this round's pick was voided by a called-off fixture and the
  // entrant is choosing a replacement, which reopens an expired deadline.
  reselecting = false,
}) {
  if (leagueStatus === 'completed' || leagueStatus === 'archived') {
    return { ok: false, code: 'league_closed', message: 'This league has finished.' };
  }
  if (entryStatus !== 'active') {
    return { ok: false, code: 'eliminated', message: 'You are out of this competition — you can still follow along.' };
  }
  if (round < 1) {
    return { ok: false, code: 'before_start', message: 'That gameweek is before the competition starts.' };
  }
  if (deadlinePassed && !reselecting) {
    return { ok: false, code: 'deadline_passed', message: 'The deadline for that gameweek has passed.' };
  }
  // Rounds 1..initialPicks must all be chosen before the entry deadline; after
  // that first kickoff the competition moves to one pick at a time.
  if (!entryDeadlinePassed) {
    if (round > initialPicks) {
      return {
        ok: false,
        code: 'too_far_ahead',
        message: `Before kick off you pick rounds 1 to ${initialPicks} only.`,
      };
    }
  } else if (!reselecting && round > currentOpenRound(usedPicks, initialPicks)) {
    return { ok: false, code: 'too_far_ahead', message: 'You can only pick for the next round.' };
  }

  const cycle = cycleForRound(round, teamCount);
  // Picks voided by a called-off fixture do not use the club up.
  const clash = usedPicks.find((pick) => pick.cycle === cycle && pick.team_id === teamId
    && pick.round_number !== round && pick.outcome !== 'void');
  if (clash) {
    return {
      ok: false,
      code: 'team_used',
      message: `You already used that team in round ${clash.round_number}. It becomes available again in round ${(cycle + 1) * teamCount + 1}.`,
    };
  }
  if (teamPlaysInRound === false) {
    return { ok: false, code: 'no_fixture', message: 'That team has no fixture in this gameweek.' };
  }
  return { ok: true };
}

/**
 * The furthest round an entry may pick for once the competition is under way:
 * the round after their last pick, so nobody runs ahead of the field. Never
 * below the initial block, which is always open until its deadlines pass.
 */
export function currentOpenRound(usedPicks, initialPicks) {
  const highest = usedPicks.reduce((max, pick) => Math.max(max, pick.round_number), 0);
  return Math.max(initialPicks, highest + 1);
}

/**
 * Who wins when a round is settled.
 * - one survivor  -> that entry wins
 * - none survive  -> everyone eliminated in this round shares the win
 * - many survive  -> the competition rolls on
 * @param {Array<{id:number, status:string, eliminated_round:?number}>} entries after settlement
 */
export function decideWinners(entries, round) {
  const survivors = entries.filter((entry) => entry.status === 'active');
  if (survivors.length === 1) return { complete: true, winnerIds: [survivors[0].id], reason: 'last_standing' };
  if (survivors.length === 0) {
    const shared = entries.filter((entry) => entry.eliminated_round === round);
    return { complete: true, winnerIds: shared.map((entry) => entry.id), reason: 'all_out_same_round' };
  }
  return { complete: false, winnerIds: [] };
}
