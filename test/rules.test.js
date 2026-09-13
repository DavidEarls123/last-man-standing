import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_POLICIES, availableTeams, cycleForRound, decideWinners, fixtureOutcome,
  gameweekForRound, isOpeningRound, isValidOpeningPicks, nextAlphabeticalTeam, openPickRounds,
  outstandingOpeningRounds, resultForOutcome, roundForGameweek, settlePick, validatePick,
} from '../src/domain/rules.js';

const finished = (home, away, homeScore, awayScore) => ({
  id: 1, status: 'finished', home_team_id: home, away_team_id: away, home_score: homeScore, away_score: awayScore,
});

test('rounds map onto gameweeks from the league start', () => {
  assert.equal(roundForGameweek(5, 5), 1);
  assert.equal(roundForGameweek(5, 9), 5);
  assert.equal(gameweekForRound(5, 1), 5);
  assert.equal(gameweekForRound(5, 5), 9);
});

test('teams free up again only after a full cycle of 20', () => {
  assert.equal(cycleForRound(1, 20), 0);
  assert.equal(cycleForRound(20, 20), 0);
  assert.equal(cycleForRound(21, 20), 1);
  assert.equal(cycleForRound(40, 20), 1);
  assert.equal(cycleForRound(41, 20), 2);
  assert.throws(() => cycleForRound(0, 20));
});

test('availableTeams excludes teams used in the same cycle only', () => {
  const teams = Array.from({ length: 20 }, (_, index) => ({ id: index + 1 }));
  const picks = [
    { team_id: 1, cycle: 0, round_number: 1 },
    { team_id: 2, cycle: 0, round_number: 2 },
  ];
  assert.equal(availableTeams(teams, picks, 3, 20).length, 18);
  // Round 21 starts a new cycle, so everything is back on the table.
  assert.equal(availableTeams(teams, picks, 21, 20).length, 20);
});

test('fixture outcomes read from the picked team point of view', () => {
  assert.equal(fixtureOutcome(finished(10, 20, 2, 1), 10), 'win');
  assert.equal(fixtureOutcome(finished(10, 20, 2, 1), 20), 'loss');
  assert.equal(fixtureOutcome(finished(10, 20, 1, 1), 10), 'draw');
  assert.equal(fixtureOutcome({ status: 'live', home_team_id: 10, away_team_id: 20, home_score: 1, away_score: 0 }, 10), 'pending');
  assert.equal(fixtureOutcome({ status: 'postponed', home_team_id: 10, away_team_id: 20 }, 10), 'void');
  assert.equal(fixtureOutcome(null, 10), 'void', 'a blank gameweek is a void pick');
  assert.throws(() => fixtureOutcome(finished(10, 20, 1, 0), 99));
});

test('a draw knocks you out by default but a league can allow it', () => {
  assert.equal(resultForOutcome('draw'), 'eliminated');
  assert.equal(resultForOutcome('draw', { drawPolicy: 'survive' }), 'survived');
  assert.equal(resultForOutcome('win', { drawPolicy: 'survive' }), 'survived');
  assert.equal(settlePick(finished(3, 4, 0, 2), 4).result, 'survived');
});

test('a called-off fixture asks for a new pick, and never eliminates by default', () => {
  // Games still to come in the gameweek: the entrant picks again.
  assert.equal(resultForOutcome('void', DEFAULT_POLICIES, { canReselect: true }), 'pending');
  // Nothing left to switch to: the round is void for them and they go through.
  assert.equal(resultForOutcome('void', DEFAULT_POLICIES, { canReselect: false }), 'survived');
  assert.equal(resultForOutcome('void', { voidPolicy: 'survive' }), 'survived');
  assert.equal(resultForOutcome('void', { voidPolicy: 'eliminate' }), 'eliminated');
});

test('a voided pick puts that club back in the pool', () => {
  const teams = [{ id: 1, name: 'Arsenal' }, { id: 2, name: 'Brentford' }, { id: 3, name: 'Chelsea' }];
  const picks = [
    { team_id: 1, cycle: 0, round_number: 1, outcome: 'win' },
    { team_id: 2, cycle: 0, round_number: 2, outcome: 'void' },
  ];
  const open = availableTeams(teams, picks, 3, 20).map((team) => team.name);
  assert.deepEqual(open, ['Brentford', 'Chelsea'], 'the club whose game was called off is selectable again');

  const clash = validatePick({
    entryStatus: 'active', leagueStatus: 'active', round: 3, teamCount: 20, usedPicks: picks,
    teamId: 2, teamPlaysInRound: true, deadlinePassed: false, nextOpenRound: 3, openingPicks: 0,
  });
  assert.equal(clash.ok, true);
});

test('a missed deadline hands over the next unused club alphabetically', () => {
  const teams = [
    { id: 1, name: 'Wolverhampton Wanderers' }, { id: 2, name: 'Arsenal' },
    { id: 3, name: 'Brentford' }, { id: 4, name: 'Chelsea' },
  ];
  const picks = [{ team_id: 2, cycle: 0, round_number: 1, outcome: 'win' }];
  assert.equal(nextAlphabeticalTeam(teams, picks, 2, 20).name, 'Brentford');

  // Clubs without a fixture are skipped.
  assert.equal(
    nextAlphabeticalTeam(teams, picks, 2, 20, (teamId) => teamId !== 3).name,
    'Chelsea',
  );
  // A club freed by a void is back at the top of the list.
  assert.equal(
    nextAlphabeticalTeam(teams, [{ team_id: 2, cycle: 0, round_number: 1, outcome: 'void' }], 2, 20).name,
    'Arsenal',
  );
  assert.equal(nextAlphabeticalTeam([], picks, 2, 20), null);
});

test('a replacement pick may be made after the deadline, but only then', () => {
  const base = {
    entryStatus: 'active', leagueStatus: 'active', round: 4, teamCount: 20, usedPicks: [],
    teamId: 9, teamPlaysInRound: true, deadlinePassed: true, nextOpenRound: 5, openingPicks: 0,
  };
  assert.equal(validatePick(base).code, 'deadline_passed');
  assert.equal(validatePick({ ...base, reselecting: true }).ok, true);
});

test('validatePick: pick as far ahead as you like, but never into a round under way', () => {
  const base = {
    entryStatus: 'active', leagueStatus: 'open', teamCount: 20, usedPicks: [],
    teamPlaysInRound: true, deadlinePassed: false, nextOpenRound: 4, openingPicks: 0,
  };
  assert.equal(validatePick({ ...base, round: 4, teamId: 1 }).ok, true);
  assert.equal(validatePick({ ...base, round: 5, teamId: 1 }).ok, true);
  assert.equal(validatePick({ ...base, round: 30, teamId: 1 }).ok, true, 'as far ahead as they wish');

  // A round already under way is closed to everyone.
  assert.equal(validatePick({ ...base, round: 3, teamId: 1 }).code, 'round_closed');
});

test('validatePick: an opening pick is final once it is made', () => {
  const base = {
    entryStatus: 'active', leagueStatus: 'open', teamCount: 20, usedPicks: [],
    teamPlaysInRound: true, deadlinePassed: false, nextOpenRound: 1, openingPicks: 3,
  };
  for (const round of [1, 2, 3]) {
    assert.equal(validatePick({ ...base, round, teamId: round }).ok, true);
  }
  // Rounds beyond the block are open too — picking ahead is just not compulsory.
  assert.equal(validatePick({ ...base, round: 4, teamId: 9 }).ok, true);

  // Changing one of the opening three is refused.
  const locked = validatePick({ ...base, round: 2, teamId: 9, hasExistingPick: true });
  assert.equal(locked.ok, false);
  assert.equal(locked.code, 'pick_locked');
  assert.match(locked.message, /3 opening picks/);

  // A pick outside the block can still be swapped until its deadline.
  assert.equal(validatePick({ ...base, round: 4, teamId: 9, hasExistingPick: true }).ok, true);

  // Being handed a replacement after a called-off game overrides the lock.
  assert.equal(
    validatePick({ ...base, round: 2, teamId: 9, hasExistingPick: true, reselecting: true }).ok,
    true,
  );
});

test('isOpeningRound marks the compulsory block, and there may not be one', () => {
  assert.equal(isOpeningRound(1, 3), true);
  assert.equal(isOpeningRound(3, 3), true);
  assert.equal(isOpeningRound(4, 3), false);
  // No block configured: nothing is locked and nothing is compulsory up front.
  assert.equal(isOpeningRound(1, 0), false);
  assert.deepEqual(outstandingOpeningRounds([], 0), []);
});

test('a league either has no opening block or one of 2 to 10 rounds', () => {
  assert.equal(isValidOpeningPicks(0), true, 'no block: nothing to configure');
  assert.equal(isValidOpeningPicks(1), false, 'a block of one is just the normal game');
  for (const size of [2, 5, 10]) assert.equal(isValidOpeningPicks(size), true);
  for (const bad of [-1, 11, 2.5, '3', null]) assert.equal(isValidOpeningPicks(bad), false);
});

test('openPickRounds covers everything still to come', () => {
  assert.deepEqual(openPickRounds(1, 4), [1, 2, 3, 4]);
  assert.deepEqual(openPickRounds(6, 8), [6, 7, 8]);
  assert.deepEqual(openPickRounds(6, 6), [6]);
  assert.deepEqual(openPickRounds(null, 8), []);
  assert.deepEqual(openPickRounds(9, 8), [], 'no rounds left in the season');
});

test('outstandingOpeningRounds says what is still owed up front', () => {
  assert.deepEqual(outstandingOpeningRounds([], 3), [1, 2, 3]);
  assert.deepEqual(outstandingOpeningRounds([{ round_number: 2 }], 3), [1, 3]);
  assert.deepEqual(outstandingOpeningRounds([{ round_number: 1 }], 1), []);
  assert.deepEqual(
    outstandingOpeningRounds([1, 2, 3].map((round_number) => ({ round_number })), 3), [],
  );
});

test('validatePick: a used team is blocked until its cycle ends', () => {
  const used = [1, 2, 3, 4].map((round) => ({ team_id: round + 5, cycle: 0, round_number: round }));
  const verdict = validatePick({
    entryStatus: 'active', leagueStatus: 'active', round: 5, teamCount: 20, usedPicks: used,
    teamId: 7, teamPlaysInRound: true, deadlinePassed: false, nextOpenRound: 5, openingPicks: 0,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'team_used');
  assert.match(verdict.message, /round 21/);
});

test('validatePick: locked out after the deadline and once eliminated', () => {
  const base = {
    entryStatus: 'active', leagueStatus: 'active', teamCount: 20, teamPlaysInRound: true,
    nextOpenRound: 4, openingPicks: 0,
    usedPicks: [1, 2, 3].map((round) => ({ team_id: round, cycle: 0, round_number: round })),
  };
  assert.equal(validatePick({ ...base, round: 4, teamId: 9, deadlinePassed: true }).code, 'deadline_passed');
  assert.equal(validatePick({ ...base, round: 4, teamId: 9, deadlinePassed: false }).ok, true);
  assert.equal(validatePick({ ...base, round: 9, teamId: 9, deadlinePassed: false }).ok, true);
  assert.equal(
    validatePick({ ...base, entryStatus: 'eliminated', round: 4, teamId: 9, deadlinePassed: false }).code,
    'eliminated',
  );
  assert.equal(
    validatePick({ ...base, round: 4, teamId: 9, deadlinePassed: false, teamPlaysInRound: false }).code,
    'no_fixture',
  );
});

test('decideWinners: one survivor wins, a wipeout is shared', () => {
  const rolling = decideWinners(
    [{ id: 1, status: 'active' }, { id: 2, status: 'active' }, { id: 3, status: 'eliminated', eliminated_round: 4 }], 4,
  );
  assert.equal(rolling.complete, false);

  const single = decideWinners([{ id: 1, status: 'active' }, { id: 2, status: 'eliminated', eliminated_round: 4 }], 4);
  assert.deepEqual(single, { complete: true, winnerIds: [1], reason: 'last_standing' });

  const wipeout = decideWinners(
    [{ id: 1, status: 'eliminated', eliminated_round: 4 }, { id: 2, status: 'eliminated', eliminated_round: 4 },
     { id: 3, status: 'eliminated', eliminated_round: 2 }], 4,
  );
  assert.equal(wipeout.complete, true);
  assert.deepEqual(wipeout.winnerIds, [1, 2]);
  assert.equal(wipeout.reason, 'all_out_same_round');
});
