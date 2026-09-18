import { config } from '../config.js';
import { platformChecks, seasonReport } from '../services/readiness.js';

/**
 * Is this ready for real people on other machines?
 *   npm run checkup
 *
 * Exits non-zero if anything would actually break a real run, so it can be the
 * last thing you do before handing out an invite link.
 */
const report = seasonReport();
const checks = [...report.checks, ...platformChecks()];

if (report.season) {
  console.log(`Season      ${report.season.name} · ${report.teams.length} clubs · `
    + `${report.counts.fixtures} fixtures (${report.counts.finished ?? 0} played)`);
  console.log(`Provider    ${config.football.provider}`);
  console.log(`Address     ${config.publicUrl}`);
  if (report.next) console.log(`Next deadline  gameweek ${report.next.number}, ${report.next.deadline}`);
  console.log('');
}

const blockers = checks.filter((check) => check.level === 'blocker');
const notes = checks.filter((check) => check.level === 'note');

for (const check of checks.filter((entry) => entry.level === 'ok')) {
  console.log(`  OK       ${check.title}${check.detail ? ` — ${check.detail}` : ''}`);
}

if (blockers.length) {
  console.error('\nSTOP — these will break a real run:');
  for (const check of blockers) console.error(`  x  ${check.title}\n       ${check.detail}`);
}
if (notes.length) {
  console.log('\nWorth knowing:');
  for (const check of notes) console.log(`  -  ${check.title}\n       ${check.detail}`);
}

console.log(blockers.length
  ? `\n${blockers.length} thing(s) to fix before real people use this.`
  : '\nReady. Nothing here would stop a real run.');
process.exit(blockers.length ? 1 : 0);
