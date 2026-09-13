import { verifyAllLeagues, verifyLeague } from '../services/verification.js';
import { flag } from './prompt.js';

/**
 * Cross-check recorded results against the fixtures:
 *   npm run verify
 *   npm run verify -- --league=3
 *
 * Exits non-zero when something disagrees, so it can be wired into a cron job.
 */
const single = flag('league');
const reports = single ? [verifyLeague(Number(single))] : verifyAllLeagues();

let failing = 0;
for (const report of reports) {
  const label = `${report.leagueName ?? 'league'} (#${report.leagueId})`;
  if (report.ok) {
    console.log(`OK   ${label} — ${report.picksChecked} picks, ${report.roundsSettled} settled rounds`);
    for (const issue of report.issues) console.log(`     note: ${issue.detail}`);
    continue;
  }
  failing += 1;
  console.error(`FAIL ${label} — ${report.errorCount} problem(s)`);
  for (const issue of report.issues) {
    const who = issue.entryName ? `${issue.entryName}: ` : '';
    const round = issue.round ? `round ${issue.round} — ` : '';
    console.error(`     [${issue.severity}] ${round}${who}${issue.detail}`);
  }
}

console.log(`\nChecked ${reports.length} league(s); ${failing} need attention.`);
process.exit(failing ? 1 : 0);
