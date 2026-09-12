import { seedSeason } from '../db/seed.js';
import { createLocalProvider } from '../services/football/local.js';
import { settleAllLeagues } from '../services/settlement.js';
import { flag } from './prompt.js';

/**
 * Loads a season of sample fixtures:
 *   npm run seed
 *   npm run seed -- --reset --results --start=2025-08-16
 */
const startFlag = flag('start');
const result = seedSeason({
  seasonName: flag('season'),
  startDate: startFlag ? new Date(String(startFlag)) : undefined,
  reset: Boolean(flag('reset', false)),
});

console.log(`Seeded ${result.seasonName}: ${result.teams} teams, ${result.gameweeks} gameweeks, ${result.fixturesCreated} new fixtures.`);

if (flag('results', false)) {
  const finished = createLocalProvider().backfillFinished();
  const settled = settleAllLeagues();
  console.log(`Generated results for ${finished} fixture(s) already played; settled ${settled.length} league round(s).`);
}
console.log('Note: these are generated sample fixtures. Set FOOTBALL_PROVIDER=football-data for the real thing.');
