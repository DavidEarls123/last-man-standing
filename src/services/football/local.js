import crypto from 'node:crypto';
import { all, run } from '../../db/index.js';
import { nowIso } from '../../lib/time.js';

const MATCH_MINUTES = 96; // 90 plus stoppage
const REAL_MS_PER_MATCH_MINUTE = 60_000;

/** Deterministic 0..1 from a seed, so a simulated match never rewrites history. */
function hashUnit(seed) {
  const digest = crypto.createHash('sha256').update(String(seed)).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

/** Poisson-ish goal count: mostly 0-3, occasionally more. */
function goalsFor(seed) {
  const value = hashUnit(seed);
  if (value < 0.26) return 0;
  if (value < 0.60) return 1;
  if (value < 0.83) return 2;
  if (value < 0.94) return 3;
  if (value < 0.985) return 4;
  return 5;
}

function finalScore(fixture) {
  // Slight home advantage baked in by seeding the home side differently.
  return {
    home: goalsFor(`${fixture.external_ref || fixture.id}:home:${fixture.home_team_id}`),
    away: goalsFor(`${fixture.external_ref || fixture.id}:away:${fixture.away_team_id}:x`),
  };
}

/** Minute-by-minute goal timings, so a simulated live score climbs believably. */
function goalMinutes(seed, count) {
  return Array.from({ length: count }, (_, index) =>
    Math.max(1, Math.round(hashUnit(`${seed}:goal:${index}`) * MATCH_MINUTES)),
  ).sort((a, b) => a - b);
}

/**
 * Local provider: fixtures and results live in this database. Results are
 * entered by the super admin, or generated when SIMULATE_LIVE is on so the app
 * can be demonstrated without a real feed.
 */
export function createLocalProvider({ simulate = false } = {}) {
  return {
    name: 'local',

    async refresh() {
      if (!simulate) return [];
      const now = Date.now();
      const changed = [];
      const fixtures = all(
        `SELECT * FROM fixtures WHERE status IN ('scheduled', 'live') AND kickoff <= ?`,
        new Date(now).toISOString(),
      );

      for (const fixture of fixtures) {
        const elapsed = (now - new Date(fixture.kickoff).getTime()) / REAL_MS_PER_MATCH_MINUTE;
        const final = finalScore(fixture);
        const seed = fixture.external_ref || fixture.id;

        if (elapsed >= MATCH_MINUTES) {
          run(
            `UPDATE fixtures SET status = 'finished', home_score = ?, away_score = ?, minute = 90, updated_at = ?
             WHERE id = ?`,
            final.home, final.away, nowIso(), fixture.id,
          );
          changed.push(fixture.id);
          continue;
        }

        const minute = Math.max(1, Math.floor(elapsed));
        const home = goalMinutes(`${seed}:home`, final.home).filter((at) => at <= minute).length;
        const away = goalMinutes(`${seed}:away`, final.away).filter((at) => at <= minute).length;
        if (fixture.status !== 'live' || fixture.home_score !== home || fixture.away_score !== away
            || fixture.minute !== minute) {
          run(
            `UPDATE fixtures SET status = 'live', home_score = ?, away_score = ?, minute = ?, updated_at = ?
             WHERE id = ?`,
            home, away, minute, nowIso(), fixture.id,
          );
          changed.push(fixture.id);
        }
      }
      return changed;
    },

    /**
     * Fill in results for fixtures that already kicked off — used by the seeder
     * so a fresh install has completed gameweeks to show.
     */
    backfillFinished(beforeIso = new Date(Date.now() - MATCH_MINUTES * 60_000).toISOString()) {
      const fixtures = all(
        `SELECT * FROM fixtures WHERE status IN ('scheduled', 'live') AND kickoff <= ?`, beforeIso,
      );
      for (const fixture of fixtures) {
        const final = finalScore(fixture);
        run(
          `UPDATE fixtures SET status = 'finished', home_score = ?, away_score = ?, minute = 90, updated_at = ?
           WHERE id = ?`,
          final.home, final.away, nowIso(), fixture.id,
        );
      }
      return fixtures.length;
    },
  };
}
