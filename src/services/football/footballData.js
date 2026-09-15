import { all, get, run } from '../../db/index.js';
import { nowIso } from '../../lib/time.js';

const STATUS_MAP = {
  SCHEDULED: 'scheduled',
  TIMED: 'scheduled',
  IN_PLAY: 'live',
  PAUSED: 'live',
  FINISHED: 'finished',
  POSTPONED: 'postponed',
  SUSPENDED: 'abandoned',
  CANCELLED: 'abandoned',
  AWARDED: 'finished',
};

const normalise = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/\b(fc|afc)\b/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');

/**
 * Live Premier League data from football-data.org (v4). Matches are keyed by
 * their upstream id, and matchday maps directly onto our gameweek number.
 */
export function createFootballDataProvider({ apiKey, competition = 'PL', seasonId }) {
  if (!apiKey) throw new Error('FOOTBALL_DATA_API_KEY is required for the football-data provider');

  async function fetchMatches() {
    const response = await fetch(
      `https://api.football-data.org/v4/competitions/${competition}/matches`,
      { headers: { 'X-Auth-Token': apiKey } },
    );
    if (response.status === 429) {
      // The free tier counts calls per minute, and the key may be shared with
      // something else. Upstream tells us how long until the counter resets;
      // believe it rather than hammering away and staying locked out.
      const reset = Number(response.headers.get('x-requestcounter-reset'));
      const error = new Error('football-data.org rate limit reached');
      error.retryAfterSeconds = Number.isFinite(reset) && reset > 0 ? reset : 60;
      throw error;
    }
    if (!response.ok) {
      throw new Error(`football-data.org responded ${response.status}: ${await response.text()}`);
    }
    return (await response.json()).matches ?? [];
  }

  function resolveSeasonId() {
    if (seasonId) return seasonId;
    const current = get('SELECT id FROM seasons WHERE is_current = 1');
    if (!current) throw new Error('No current season — run `npm run seed` first');
    return current.id;
  }

  function teamIndex(season) {
    const index = new Map();
    for (const team of all('SELECT id, name, short_name, external_ref FROM teams WHERE season_id = ?', season)) {
      index.set(normalise(team.name), team.id);
      index.set(normalise(team.short_name), team.id);
      if (team.external_ref) index.set(`id:${team.external_ref}`, team.id);
    }
    return index;
  }

  function resolveTeam(index, upstream) {
    return index.get(`id:${upstream.id}`)
      ?? index.get(normalise(upstream.name))
      ?? index.get(normalise(upstream.shortName))
      ?? index.get(normalise(upstream.tla))
      ?? null;
  }

  return {
    name: 'football-data',
    // Every refresh costs a call against a rate-limited key, so the scheduler
    // asks only when there is football to see.
    metered: true,

    /** Pull the whole season: creates gameweeks and fixtures, updates scores. */
    async refresh() {
      const season = resolveSeasonId();
      const index = teamIndex(season);
      const matches = await fetchMatches();
      const changed = [];
      const unmatched = new Set();

      for (const match of matches) {
        if (!match.matchday) continue;
        const homeId = resolveTeam(index, match.homeTeam || {});
        const awayId = resolveTeam(index, match.awayTeam || {});
        if (!homeId || !awayId) {
          unmatched.add(`${match.homeTeam?.name} v ${match.awayTeam?.name}`);
          continue;
        }

        run(
          `INSERT INTO gameweeks (season_id, number, deadline) VALUES (?, ?, ?)
           ON CONFLICT(season_id, number) DO UPDATE SET
             deadline = MIN(gameweeks.deadline, excluded.deadline)`,
          season, match.matchday, match.utcDate,
        );
        const gameweek = get('SELECT * FROM gameweeks WHERE season_id = ? AND number = ?', season, match.matchday);

        const status = STATUS_MAP[match.status] ?? 'scheduled';
        const score = match.score?.fullTime ?? {};
        const ref = `fd-${match.id}`;
        const existing = get('SELECT * FROM fixtures WHERE external_ref = ?', ref);

        if (!existing) {
          run(
            `INSERT INTO fixtures (gameweek_id, home_team_id, away_team_id, kickoff, status, home_score, away_score, minute, external_ref, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            gameweek.id, homeId, awayId, match.utcDate, status,
            score.home ?? null, score.away ?? null, match.minute ?? null, ref, nowIso(),
          );
          changed.push(ref);
        } else if (
          existing.status !== status || existing.home_score !== (score.home ?? null)
          || existing.away_score !== (score.away ?? null) || existing.kickoff !== match.utcDate
        ) {
          run(
            `UPDATE fixtures SET gameweek_id = ?, kickoff = ?, status = ?, home_score = ?, away_score = ?, minute = ?, updated_at = ?
             WHERE id = ?`,
            gameweek.id, match.utcDate, status, score.home ?? null, score.away ?? null,
            match.minute ?? null, nowIso(), existing.id,
          );
          changed.push(existing.id);
        }
      }

      if (unmatched.size) {
        console.warn(`[football-data] could not match teams for ${unmatched.size} fixture(s):`,
          [...unmatched].slice(0, 5).join('; '));
      }
      // Deadlines must track the earliest kickoff, which can move.
      run(
        `UPDATE gameweeks SET deadline = COALESCE(
           (SELECT MIN(f.kickoff) FROM fixtures f WHERE f.gameweek_id = gameweeks.id), deadline)
         WHERE season_id = ?`,
        season,
      );
      return changed;
    },
  };
}
