import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, transaction } from './index.js';
import { config } from '../config.js';

/**
 * Generates a full 38-gameweek Premier League season of SAMPLE fixtures using
 * the circle method, so the app is usable end to end without an external feed.
 * Real fixtures come from the football-data.org provider — see README.
 */

// Kickoff slots within a gameweek weekend, as [dayOffsetFromSaturday, hour, minute].
const SLOTS = [
  [-1, 20, 0],  // Friday night
  [0, 12, 30], [0, 15, 0], [0, 15, 0], [0, 15, 0], [0, 15, 0], [0, 17, 30],
  [1, 14, 0], [1, 16, 30],
  [2, 20, 0],   // Monday night
];

function roundRobin(teamIds) {
  const teams = [...teamIds];
  const rounds = [];
  const half = teams.length / 2;
  const rotating = teams.slice(1);
  for (let round = 0; round < teams.length - 1; round += 1) {
    const line = [teams[0], ...rotating];
    const pairs = [];
    for (let i = 0; i < half; i += 1) {
      const home = line[i];
      const away = line[line.length - 1 - i];
      // Alternate home advantage so no side is always at home.
      pairs.push(round % 2 === 0 ? [home, away] : [away, home]);
    }
    rounds.push(pairs);
    rotating.unshift(rotating.pop());
  }
  return rounds;
}

/** Saturday of the week containing `date`, at 00:00 UTC. */
function saturdayOf(date) {
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const shift = (6 - result.getUTCDay() + 7) % 7;
  result.setUTCDate(result.getUTCDate() + shift);
  return result;
}

export function seedSeason({ seasonName, startDate, teams, reset = false } = {}) {
  const definition = JSON.parse(
    fs.readFileSync(path.join(config.root, 'data', 'teams.json'), 'utf8'),
  );
  const teamList = teams ?? definition.teams;
  const name = seasonName ?? definition.season;

  return transaction(() => {
    if (reset) {
      const existing = get('SELECT id FROM seasons WHERE name = ?', name);
      if (existing) {
        run('DELETE FROM fixtures WHERE gameweek_id IN (SELECT id FROM gameweeks WHERE season_id = ?)', existing.id);
        run('DELETE FROM gameweeks WHERE season_id = ?', existing.id);
      }
    }

    run('UPDATE seasons SET is_current = 0');
    run(`INSERT INTO seasons (name, is_current) VALUES (?, 1)
         ON CONFLICT(name) DO UPDATE SET is_current = 1`, name);
    const season = get('SELECT * FROM seasons WHERE name = ?', name);

    for (const team of teamList) {
      run(
        `INSERT INTO teams (season_id, name, short_name) VALUES (?, ?, ?)
         ON CONFLICT(season_id, name) DO UPDATE SET short_name = excluded.short_name`,
        season.id, team.name, team.shortName,
      );
    }
    const teamIds = all('SELECT id FROM teams WHERE season_id = ? ORDER BY id', season.id).map((row) => row.id);
    if (teamIds.length % 2 !== 0) throw new Error('An even number of teams is required');

    // Gameweek 1 kicks off the Saturday of the given week (default: four weeks ago,
    // so a fresh install has settled rounds, a live round and upcoming deadlines).
    const anchor = saturdayOf(startDate ?? new Date(Date.now() - 28 * 86_400_000));
    const firstHalf = roundRobin(teamIds);
    const schedule = [...firstHalf, ...firstHalf.map((round) => round.map(([home, away]) => [away, home]))];

    let created = 0;
    schedule.forEach((pairs, index) => {
      const number = index + 1;
      const weekStart = new Date(anchor);
      weekStart.setUTCDate(weekStart.getUTCDate() + index * 7);

      const kickoffs = pairs.map((pair, slotIndex) => {
        const [dayOffset, hour, minute] = SLOTS[slotIndex % SLOTS.length];
        const kickoff = new Date(weekStart);
        kickoff.setUTCDate(kickoff.getUTCDate() + dayOffset);
        kickoff.setUTCHours(hour, minute, 0, 0);
        return { pair, kickoff };
      });

      const deadline = new Date(Math.min(...kickoffs.map(({ kickoff }) => kickoff.getTime()))).toISOString();
      run(
        `INSERT INTO gameweeks (season_id, number, deadline) VALUES (?, ?, ?)
         ON CONFLICT(season_id, number) DO UPDATE SET deadline = excluded.deadline`,
        season.id, number, deadline,
      );
      const gameweek = get('SELECT * FROM gameweeks WHERE season_id = ? AND number = ?', season.id, number);

      for (const { pair, kickoff } of kickoffs) {
        const [homeId, awayId] = pair;
        const ref = `sample-${season.id}-${number}-${homeId}-${awayId}`;
        const existing = get('SELECT id FROM fixtures WHERE external_ref = ?', ref);
        if (existing) continue;
        run(
          `INSERT INTO fixtures (gameweek_id, home_team_id, away_team_id, kickoff, status, external_ref, updated_at)
           VALUES (?, ?, ?, ?, 'scheduled', ?, ?)`,
          gameweek.id, homeId, awayId, kickoff.toISOString(), ref, new Date().toISOString(),
        );
        created += 1;
      }
    });

    return { seasonId: season.id, seasonName: name, teams: teamIds.length, gameweeks: schedule.length, fixturesCreated: created };
  });
}
