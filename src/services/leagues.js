import { all, get, run, audit } from '../db/index.js';
import { randomCode } from '../lib/auth.js';
import { conflict, notFound } from '../lib/errors.js';
import { nowIso } from '../lib/time.js';
import { cycleForRound, gameweekForRound, roundForGameweek } from '../domain/rules.js';

export function getLeague(leagueId) {
  const league = get('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!league) throw notFound('League not found');
  return league;
}

export function getLeagueByCode(code) {
  return get('SELECT * FROM leagues WHERE join_code = ?', String(code || '').trim().toUpperCase());
}

export const leagueTeams = (seasonId) =>
  all('SELECT id, name, short_name FROM teams WHERE season_id = ? ORDER BY name', seasonId);

export const seasonGameweeks = (seasonId) =>
  all('SELECT * FROM gameweeks WHERE season_id = ? ORDER BY number', seasonId);

export const policiesFor = (league) => ({
  drawPolicy: league.draw_policy,
  voidPolicy: league.void_policy,
  noPickPolicy: league.no_pick_policy,
});

/**
 * Everything the rest of the app needs to reason about where a league is up to:
 * its team pool, the entry deadline, and which round is open, in play or done.
 */
export function leagueContext(leagueOrId) {
  const league = typeof leagueOrId === 'object' ? leagueOrId : getLeague(leagueOrId);
  const teams = leagueTeams(league.season_id);
  const teamCount = teams.length;
  const gameweeks = seasonGameweeks(league.season_id).filter((gw) => gw.number >= league.start_gameweek);
  const now = Date.now();

  const rounds = gameweeks.map((gameweek) => {
    const round = roundForGameweek(league.start_gameweek, gameweek.number);
    const fixtures = all('SELECT * FROM fixtures WHERE gameweek_id = ? ORDER BY kickoff', gameweek.id);
    const settled = fixtures.length > 0 &&
      fixtures.every((fixture) => ['finished', 'postponed', 'abandoned'].includes(fixture.status));
    return {
      round,
      cycle: cycleForRound(round, teamCount || 1),
      gameweek,
      deadline: gameweek.deadline,
      deadlinePassed: new Date(gameweek.deadline).getTime() <= now,
      fixtures,
      settled,
      inPlay: new Date(gameweek.deadline).getTime() <= now && !settled,
    };
  });

  const entryDeadline = rounds[0]?.deadline ?? null;
  const entryClosed = entryDeadline ? new Date(entryDeadline).getTime() <= now : false;
  const nextOpen = rounds.find((round) => !round.deadlinePassed) ?? null;
  const inPlay = rounds.find((round) => round.inPlay) ?? null;
  const lastSettled = [...rounds].reverse().find((round) => round.settled) ?? null;

  return {
    league,
    teams,
    teamCount,
    policies: policiesFor(league),
    rounds,
    entryDeadline,
    entryClosed,
    // Settings, rules and branding freeze once the admin locks them in, and in
    // any case once the first ball is kicked. Only the super admin reopens them.
    // A league is live once its admin has confirmed and launched it. Until
    // then it is a draft: no invite link, and nobody can join.
    launched: Boolean(league.launched_at),
    launchedAt: league.launched_at,
    configLocked: Boolean(league.config_locked_at) || entryClosed,
    configLockedAt: league.config_locked_at,
    configLockReason: league.config_locked_at ? 'locked_by_admin' : entryClosed ? 'competition_started' : null,
    nextOpenRound: nextOpen?.round ?? null,
    roundInPlay: inPlay?.round ?? null,
    lastSettledRound: lastSettled?.round ?? null,
    // What the "current gameweek" tab should show.
    focusRound: inPlay?.round ?? nextOpen?.round ?? lastSettled?.round ?? 1,
    roundInfo: (round) => rounds.find((entryRound) => entryRound.round === round) ?? null,
  };
}

export function generateJoinCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = randomCode(6);
    if (!get('SELECT 1 FROM leagues WHERE join_code = ?', code)) return code;
  }
  throw conflict('Could not allocate a unique join code, please retry');
}

export function createLeague({
  name, seasonId, startGameweek, adminUserId, createdBy,
  openingPicks = 0, drawPolicy = 'eliminate', voidPolicy = 'reselect',
  noPickPolicy = 'auto_alphabetical', maxEntries = null,
  // A league starts as a draft. Its admin confirms and launches it, which is
  // what issues the invite code and lets anyone join.
  launched = false,
}) {
  const gameweek = get('SELECT * FROM gameweeks WHERE season_id = ? AND number = ?', seasonId, startGameweek);
  if (!gameweek) throw notFound(`Gameweek ${startGameweek} does not exist in that season`);

  const joinCode = generateJoinCode();
  const result = run(
    `INSERT INTO leagues
      (name, join_code, season_id, start_gameweek, status, admin_user_id, created_by_user_id,
       opening_picks, draw_policy, void_policy, no_pick_policy, max_entries, launched_at, created_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    name, joinCode, seasonId, startGameweek, adminUserId ?? null, createdBy,
    openingPicks, drawPolicy, voidPolicy, noPickPolicy, maxEntries,
    launched ? nowIso() : null, nowIso(),
  );
  const leagueId = Number(result.lastInsertRowid);
  audit(createdBy, 'league.create', 'league', leagueId, { name, startGameweek, joinCode });
  return getLeague(leagueId);
}

export function getEntry(leagueId, userId) {
  return get('SELECT * FROM entries WHERE league_id = ? AND user_id = ?', leagueId, userId);
}

/**
 * Add an entry. Entries slam shut at the first kick off of the start gameweek;
 * `force` is the super admin's override for putting things right.
 */
export function joinLeague(league, userId, { force = false } = {}) {
  const existing = getEntry(league.id, userId);
  if (existing) return existing;

  const context = leagueContext(league);
  if (!league.launched_at && !force) {
    throw conflict('This league has not been launched yet — its admin is still setting it up');
  }
  if (context.entryClosed && !force) {
    throw conflict('Entries closed at the first kick off of gameweek ' + league.start_gameweek);
  }
  if (league.status !== 'open' && !force) throw conflict('This league is not accepting entries');
  if (league.max_entries && !force) {
    const { count } = get('SELECT COUNT(*) AS count FROM entries WHERE league_id = ?', league.id);
    if (count >= league.max_entries) throw conflict('This league is full');
  }

  run(
    'INSERT INTO entries (league_id, user_id, status, joined_at) VALUES (?, ?, \'active\', ?)',
    league.id, userId, nowIso(),
  );
  audit(userId, 'league.join', 'league', league.id, { userId });
  return getEntry(league.id, userId);
}

/** Headline numbers for the home tab: entries, survivors, per-round casualties. */
export function leagueOverview(league) {
  const context = leagueContext(league);
  const entries = all('SELECT * FROM entries WHERE league_id = ?', league.id);
  const total = entries.length;
  const active = entries.filter((entry) => entry.status === 'active').length;
  const eliminated = entries.filter((entry) => entry.status === 'eliminated').length;

  const byRound = new Map();
  for (const entry of entries) {
    if (entry.status !== 'eliminated' || entry.eliminated_round == null) continue;
    byRound.set(entry.eliminated_round, (byRound.get(entry.eliminated_round) || 0) + 1);
  }

  let remaining = total;
  const rounds = [];
  for (const round of context.rounds) {
    if (!round.settled && round.round !== context.roundInPlay) continue;
    if (round.round > (context.lastSettledRound ?? 0) && round.round !== context.roundInPlay) continue;
    const out = byRound.get(round.round) || 0;
    const startedWith = remaining;
    remaining -= out;
    rounds.push({
      round: round.round,
      gameweek: round.gameweek.number,
      startedWith,
      eliminated: out,
      survivors: remaining,
      survivalPct: startedWith ? Math.round((remaining / startedWith) * 1000) / 10 : 0,
    });
  }

  return {
    totalEntries: total,
    active,
    eliminated,
    survivalPct: total ? Math.round((active / total) * 1000) / 10 : 0,
    eliminationPct: total ? Math.round((eliminated / total) * 1000) / 10 : 0,
    rounds,
    winners: entries.filter((entry) => entry.is_winner).map((entry) => entry.id),
  };
}

/** Standings for the league table: survivors first, then latest exits. */
export function leagueStandings(league) {
  return all(
    `SELECT e.id AS entry_id, e.status, e.eliminated_round, e.eliminated_reason, e.is_winner,
            u.id AS user_id, u.display_name,
            (SELECT COUNT(*) FROM picks p WHERE p.entry_id = e.id AND p.result = 'survived') AS rounds_survived
     FROM entries e
     JOIN users u ON u.id = e.user_id
     WHERE e.league_id = ?
     ORDER BY e.is_winner DESC,
              CASE e.status WHEN 'active' THEN 0 WHEN 'eliminated' THEN 1 ELSE 2 END,
              e.eliminated_round DESC,
              u.display_name COLLATE NOCASE`,
    league.id,
  );
}

export const gameweekForLeagueRound = (league, round) =>
  get('SELECT * FROM gameweeks WHERE season_id = ? AND number = ?',
    league.season_id, gameweekForRound(league.start_gameweek, round));
