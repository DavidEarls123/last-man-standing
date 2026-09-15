import { all, get } from '../db/index.js';
import { config } from '../config.js';

/**
 * What the database thinks the season is:
 *   npm run season
 *
 * Answers the question you actually have after a seed — did the real fixtures
 * land, and is every club matched? Exits non-zero if something is wrong, so it
 * can be wired into a check.
 */
const season = get('SELECT * FROM seasons WHERE is_current = 1');
if (!season) {
  console.error('No current season. Run `npm run seed`.');
  process.exit(1);
}

const teams = all('SELECT * FROM teams WHERE season_id = ? ORDER BY name', season.id);
const orphans = teams.filter((team) => !team.external_ref);
const counts = get(
  `SELECT COUNT(DISTINCT g.id) AS gameweeks,
          COUNT(f.id)          AS fixtures,
          SUM(CASE WHEN f.external_ref LIKE 'sample-%' THEN 1 ELSE 0 END) AS sample,
          SUM(CASE WHEN f.status = 'finished' THEN 1 ELSE 0 END)          AS finished
     FROM gameweeks g LEFT JOIN fixtures f ON f.gameweek_id = g.id
    WHERE g.season_id = ?`, season.id,
);
const next = get(
  `SELECT g.number, g.deadline FROM gameweeks g
    WHERE g.season_id = ? AND g.deadline > datetime('now')
    ORDER BY g.deadline LIMIT 1`, season.id,
);

console.log(`Season      ${season.name}`);
console.log(`Provider    ${config.football.provider}`);
console.log(`Clubs       ${teams.length}`);
console.log(`Gameweeks   ${counts.gameweeks}`);
console.log(`Fixtures    ${counts.fixtures} (${counts.finished ?? 0} played)`);
console.log(next
  ? `Next deadline  gameweek ${next.number}, ${next.deadline}`
  : 'Next deadline  none — every gameweek has started');

const problems = [];
if (config.football.provider === 'football-data' && counts.sample > 0) {
  problems.push(`${counts.sample} generated sample fixture(s) are still in the database — `
    + 'delete data/lms.sqlite and re-seed.');
}
// Only meaningful against a real feed. On the local provider nothing has an
// upstream id, and nothing should.
if (config.football.provider === 'football-data' && orphans.length) {
  problems.push(`${orphans.length} club(s) have no upstream id, so their fixtures cannot be `
    + `matched and they will never appear as a pick: ${orphans.map((t) => t.name).join(', ')}`);
}
if (teams.length !== 20) {
  problems.push(`Expected 20 clubs, found ${teams.length}.`);
}

if (problems.length) {
  console.error('\nProblems:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('\nAll clubs matched. Nothing wrong here.');
