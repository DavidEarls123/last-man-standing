import { seedSeason } from '../db/seed.js';
import { all, get } from '../db/index.js';
import { config } from '../config.js';
import { footballProvider } from '../services/football/index.js';
import { createLocalProvider } from '../services/football/local.js';
import { settleAllLeagues } from '../services/settlement.js';
import { flag } from './prompt.js';

/**
 * Loads a season.
 *
 *   npm run seed
 *   npm run seed -- --reset --results --start=2025-08-16
 *
 * With FOOTBALL_PROVIDER=football-data this pulls the real clubs and the real
 * fixture list. Otherwise it generates a sample season from data/teams.json so
 * the app is usable end to end without a feed.
 */
const startFlag = flag('start');
const reset = Boolean(flag('reset', false));

if (config.football.provider === 'football-data') {
  const provider = footballProvider();

  // The clubs come from the feed, not from a file. Three or four change every
  // summer, and a club the feed knows about but the database does not is a
  // fixture that silently cannot be matched.
  const season = await provider.season();
  const seeded = seedSeason({ seasonName: season.name, teams: season.teams, reset, fixtures: false });
  console.log(`Seeded ${seeded.seasonName} from football-data.org: ${seeded.teams} clubs.`);

  const changed = await provider.refresh();
  const gameweeks = get(
    'SELECT COUNT(*) AS n FROM gameweeks WHERE season_id = ?', seeded.seasonId,
  ).n;
  const fixtures = get(
    `SELECT COUNT(*) AS n FROM fixtures f
      JOIN gameweeks g ON g.id = f.gameweek_id WHERE g.season_id = ?`, seeded.seasonId,
  ).n;
  console.log(`Fixtures: ${gameweeks} gameweeks, ${fixtures} fixtures (${changed.length} added or updated just now).`);

  // Loud, because a club that cannot be matched quietly removes itself from
  // everybody's list of possible picks.
  const orphans = all(
    'SELECT name FROM teams WHERE season_id = ? AND external_ref IS NULL ORDER BY name', seeded.seasonId,
  );
  if (orphans.length) {
    console.warn(`\nWarning: ${orphans.length} club(s) are in the database but not in the feed:`);
    console.warn(`  ${orphans.map((team) => team.name).join(', ')}`);
    console.warn('Run `npm run seed -- --reset` to clear the old season out.');
  }
} else {
  const result = seedSeason({
    seasonName: flag('season'),
    startDate: startFlag ? new Date(String(startFlag)) : undefined,
    reset,
  });
  console.log(`Seeded ${result.seasonName}: ${result.teams} teams, ${result.gameweeks} gameweeks, ${result.fixturesCreated} new fixtures.`);

  if (flag('results', false)) {
    const finished = createLocalProvider().backfillFinished();
    const settled = settleAllLeagues();
    console.log(`Generated results for ${finished} fixture(s) already played; settled ${settled.length} league round(s).`);
  }
  console.log('Note: these are generated sample fixtures. Set FOOTBALL_PROVIDER=football-data for the real thing.');
}
