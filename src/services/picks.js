import { all, get, run, audit } from '../db/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { nowIso } from '../lib/time.js';
import { availableTeams, cycleForRound, validatePick } from '../domain/rules.js';
import { gameweekForLeagueRound, leagueContext } from './leagues.js';

export const entryPicks = (entryId) =>
  all(
    `SELECT p.id, p.round_number, p.cycle, p.outcome, p.result, p.team_id, p.created_at, p.updated_at,
            p.needs_reselect, p.reselect_deadline, p.auto_assigned,
            t.name AS team_name, t.short_name AS team_short,
            g.number AS gameweek, g.deadline
     FROM picks p
     JOIN teams t ON t.id = p.team_id
     JOIN gameweeks g ON g.id = p.gameweek_id
     WHERE p.entry_id = ?
     ORDER BY p.round_number`,
    entryId,
  );

export const usedPicks = (entryId) =>
  all('SELECT team_id, cycle, round_number, outcome FROM picks WHERE entry_id = ?', entryId);

/** The fixture a team plays in a gameweek, or null for a blank gameweek. */
export const fixtureForTeam = (gameweekId, teamId) =>
  get(
    'SELECT * FROM fixtures WHERE gameweek_id = ? AND (home_team_id = ? OR away_team_id = ?)',
    gameweekId, teamId, teamId,
  );

export function availableTeamsForRound(league, entry, round) {
  const context = leagueContext(league);
  const gameweek = gameweekForLeagueRound(league, round);
  if (!gameweek) throw notFound(`Round ${round} has no gameweek in this season`);

  const picks = usedPicks(entry.id);
  const cycle = cycleForRound(round, context.teamCount || 1);
  // A pick already made for THIS round is not "used up" — it is the current
  // choice, and can be kept or swapped until the deadline.
  const currentPick = get('SELECT * FROM picks WHERE entry_id = ? AND round_number = ?', entry.id, round);
  const otherPicks = picks.filter((pick) => pick.round_number !== round);
  const usedThisCycle = new Map(
    otherPicks.filter((pick) => pick.cycle === cycle).map((pick) => [pick.team_id, pick.round_number]),
  );
  const open = new Set(
    availableTeams(context.teams, otherPicks, round, context.teamCount || 1).map((team) => team.id),
  );

  // Replacing a pick after the deadline (because the fixture was called off)
  // may only use teams whose own game has not started yet.
  const reselecting = Boolean(currentPick?.needs_reselect);
  const startedTeams = new Set();
  if (reselecting) {
    for (const fixture of all('SELECT * FROM fixtures WHERE gameweek_id = ?', gameweek.id)) {
      if (new Date(fixture.kickoff).getTime() > Date.now() && fixture.status === 'scheduled') continue;
      startedTeams.add(fixture.home_team_id);
      startedTeams.add(fixture.away_team_id);
    }
  }

  return context.teams.map((team) => {
    const fixture = fixtureForTeam(gameweek.id, team.id);
    const playable = Boolean(fixture) && !['postponed', 'abandoned'].includes(fixture?.status)
      && !startedTeams.has(team.id);
    const opponentId = fixture ? (fixture.home_team_id === team.id ? fixture.away_team_id : fixture.home_team_id) : null;
    const opponent = opponentId ? context.teams.find((candidate) => candidate.id === opponentId) : null;
    return {
      teamId: team.id,
      name: team.name,
      shortName: team.short_name,
      available: open.has(team.id) && playable,
      usedInRound: usedThisCycle.get(team.id) ?? null,
      isCurrentPick: currentPick?.team_id === team.id,
      fixture: fixture
        ? {
            id: fixture.id,
            kickoff: fixture.kickoff,
            status: fixture.status,
            home: fixture.home_team_id === team.id,
            opponent: opponent?.name ?? null,
            opponentShort: opponent?.short_name ?? null,
          }
        : null,
    };
  });
}

/**
 * Record (or change) a pick. Picks stay editable right up to that gameweek's
 * deadline; after the deadline they are locked.
 */
export function submitPick({ league, entry, round, teamId, actorUserId, override = false, autoAssigned = false }) {
  const context = leagueContext(league);
  const gameweek = gameweekForLeagueRound(league, round);
  if (!gameweek) throw notFound(`Round ${round} has no gameweek in this season`);

  const team = context.teams.find((candidate) => candidate.id === Number(teamId));
  if (!team) throw badRequest('Unknown team for this season');

  const fixture = fixtureForTeam(gameweek.id, team.id);
  const existingPick = get('SELECT * FROM picks WHERE entry_id = ? AND gameweek_id = ?', entry.id, gameweek.id);
  const reselecting = Boolean(existingPick?.needs_reselect);

  if (reselecting && !override) {
    // The replacement has to be a game that has not kicked off yet.
    if (!fixture || ['postponed', 'abandoned'].includes(fixture.status)
        || new Date(fixture.kickoff).getTime() <= Date.now() || fixture.status !== 'scheduled') {
      throw conflict('Pick a team whose game has not kicked off yet.', { code: 'already_started' });
    }
  }

  if (!override) {
    const verdict = validatePick({
      entryStatus: entry.status,
      leagueStatus: league.status,
      round,
      teamCount: context.teamCount,
      usedPicks: usedPicks(entry.id),
      teamId: team.id,
      teamPlaysInRound: Boolean(fixture),
      deadlinePassed: new Date(gameweek.deadline).getTime() <= Date.now(),
      entryDeadlinePassed: context.entryClosed,
      initialPicks: league.initial_picks,
      reselecting,
    });
    if (!verdict.ok) throw conflict(verdict.message, { code: verdict.code });
  }

  const cycle = cycleForRound(round, context.teamCount || 1);
  const existing = existingPick;
  const now = nowIso();

  if (existing) {
    if (existing.result !== 'pending' && !override) {
      throw conflict('That round has already been settled.');
    }
    run(
      `UPDATE picks SET team_id = ?, cycle = ?, outcome = 'pending', result = 'pending',
              needs_reselect = 0, reselect_deadline = NULL, auto_assigned = ?, updated_at = ?
       WHERE id = ?`,
      team.id, cycle, autoAssigned ? 1 : 0, now, existing.id,
    );
  } else {
    run(
      `INSERT INTO picks (entry_id, league_id, gameweek_id, round_number, cycle, team_id, auto_assigned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.id, league.id, gameweek.id, round, cycle, team.id, autoAssigned ? 1 : 0, now, now,
    );
  }

  audit(actorUserId, existing ? 'pick.update' : 'pick.create', 'entry', entry.id, {
    leagueId: league.id, round, teamId: team.id, override, autoAssigned, reselecting,
  });
  return get('SELECT * FROM picks WHERE entry_id = ? AND gameweek_id = ?', entry.id, gameweek.id);
}

/**
 * How the field has picked for a round. Only teams that were actually picked
 * are returned, most popular first.
 */
export function pickPopularity(league, round) {
  const gameweek = gameweekForLeagueRound(league, round);
  if (!gameweek) return { round, gameweek: null, totalPicks: 0, teams: [] };

  const rows = all(
    `SELECT p.team_id, t.name, t.short_name, COUNT(*) AS picks
     FROM picks p
     JOIN teams t ON t.id = p.team_id
     JOIN entries e ON e.id = p.entry_id
     WHERE p.league_id = ? AND p.round_number = ? AND e.status IN ('active', 'eliminated')
     GROUP BY p.team_id
     ORDER BY picks DESC, t.name`,
    league.id, round,
  );
  const totalPicks = rows.reduce((sum, row) => sum + row.picks, 0);

  const teams = rows.map((row) => {
    const fixture = fixtureForTeam(gameweek.id, row.team_id);
    return {
      teamId: row.team_id,
      name: row.name,
      shortName: row.short_name,
      picks: row.picks,
      pct: totalPicks ? Math.round((row.picks / totalPicks) * 1000) / 10 : 0,
      fixtureId: fixture?.id ?? null,
    };
  });

  return { round, gameweek: gameweek.number, deadline: gameweek.deadline, totalPicks, teams };
}

/**
 * Fixtures for a round with live scores and, beside each side, how many
 * entrants in this league are riding on that team.
 */
export function roundFixturesWithPicks(league, round) {
  const gameweek = gameweekForLeagueRound(league, round);
  if (!gameweek) return { round, gameweek: null, fixtures: [] };

  const counts = new Map(
    all(
      `SELECT p.team_id, COUNT(*) AS picks
       FROM picks p WHERE p.league_id = ? AND p.round_number = ? GROUP BY p.team_id`,
      league.id, round,
    ).map((row) => [row.team_id, row.picks]),
  );
  const totalPicks = [...counts.values()].reduce((sum, value) => sum + value, 0);

  const fixtures = all(
    `SELECT f.*, h.name AS home_name, h.short_name AS home_short, a.name AS away_name, a.short_name AS away_short
     FROM fixtures f
     JOIN teams h ON h.id = f.home_team_id
     JOIN teams a ON a.id = f.away_team_id
     WHERE f.gameweek_id = ?
     ORDER BY f.kickoff, h.name`,
    gameweek.id,
  ).map((fixture) => ({
    id: fixture.id,
    kickoff: fixture.kickoff,
    status: fixture.status,
    minute: fixture.minute,
    homeScore: fixture.home_score,
    awayScore: fixture.away_score,
    home: {
      teamId: fixture.home_team_id,
      name: fixture.home_name,
      shortName: fixture.home_short,
      picks: counts.get(fixture.home_team_id) || 0,
      pct: totalPicks ? Math.round(((counts.get(fixture.home_team_id) || 0) / totalPicks) * 1000) / 10 : 0,
    },
    away: {
      teamId: fixture.away_team_id,
      name: fixture.away_name,
      shortName: fixture.away_short,
      picks: counts.get(fixture.away_team_id) || 0,
      pct: totalPicks ? Math.round(((counts.get(fixture.away_team_id) || 0) / totalPicks) * 1000) / 10 : 0,
    },
  }));

  return { round, gameweek: gameweek.number, deadline: gameweek.deadline, totalPicks, fixtures };
}
