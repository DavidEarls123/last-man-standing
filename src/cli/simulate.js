import { all, get, run } from '../db/index.js';
import { config } from '../config.js';
import { leagueContext } from '../services/leagues.js';
import { createLocalProvider } from '../services/football/local.js';
import { flagReselections, settleAllLeagues } from '../services/settlement.js';
import { applyAutoPicks } from '../scheduler.js';
import { verifyLeague } from '../services/verification.js';
import { flag } from './prompt.js';

/**
 * Fast-forward a competition so you can watch the rules work without waiting
 * for real football.
 *
 *   npm run simulate                    where every league is up to
 *   npm run simulate -- --advance       play out the next round
 *   npm run simulate -- --rounds=5      play out five
 *   npm run simulate -- --deadline=10   put the next deadline 10 minutes away
 *   npm run simulate -- --league=2      just that one
 *
 * It moves kick-off times around, so it is only for a seeded sample season.
 */

if (config.football.provider !== 'local') {
  console.error('This only works with FOOTBALL_PROVIDER=local — a real feed would overwrite the results.');
  process.exit(1);
}

const only = flag('league') ? Number(flag('league')) : null;
const leagues = () => all(
  `SELECT * FROM leagues WHERE status IN ('open', 'active') ${only ? 'AND id = ?' : ''} ORDER BY id`,
  ...(only ? [only] : []),
);

const bar = (survivors, total, width = 24) => {
  const filled = total ? Math.round((survivors / total) * width) : 0;
  return `${'█'.repeat(filled)}${'·'.repeat(width - filled)}`;
};

function report(league) {
  const context = leagueContext(league);
  const entries = all('SELECT status FROM entries WHERE league_id = ?', league.id);
  const active = entries.filter((entry) => entry.status === 'active').length;
  const next = context.nextOpenRound;
  const deadline = next ? context.roundInfo(next)?.deadline : null;
  const minutes = deadline ? Math.round((new Date(deadline) - Date.now()) / 60000) : null;

  console.log(
    `  ${String(league.id).padStart(3)}  ${league.name.padEnd(24).slice(0, 24)}  ` +
    `${bar(active, entries.length)}  ${String(active).padStart(4)}/${String(entries.length).padEnd(4)} in  ` +
    (league.status === 'completed'
      ? 'complete'
      : next
        ? `round ${next} in ${minutes > 1440 ? `${Math.round(minutes / 1440)}d` : `${minutes}m`}`
        : 'no rounds left'),
  );
}

/** Bring a gameweek's kick-offs into the past so the round can be played out. */
function bringForward(gameweekId, minutesAgo) {
  const when = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const fixtures = all('SELECT * FROM fixtures WHERE gameweek_id = ? ORDER BY kickoff', gameweekId);
  fixtures.forEach((fixture, index) => {
    // Keep them in their original order, a couple of hours apart.
    const kickoff = new Date(Date.now() - (minutesAgo - index * 2) * 60_000).toISOString();
    run('UPDATE fixtures SET kickoff = ? WHERE id = ?', kickoff, fixture.id);
  });
  run('UPDATE gameweeks SET deadline = ? WHERE id = ?', when, gameweekId);
}

function advanceOnce(league) {
  const context = leagueContext(league);
  // The first round that has not finished — which may be one already under way,
  // not the next one open for picking. Settlement works in order, so skipping
  // over a half-played round would leave everything behind it unsettled.
  const info = context.rounds.find((round) => !round.settled);
  if (!info) return { done: true };
  const round = info.round;

  const before = get(
    "SELECT COUNT(*) AS count FROM entries WHERE league_id = ? AND status = 'active'", league.id,
  ).count;

  // The deadline passes, anyone who has not picked is given a club, the games
  // are played, and the round is settled — the same order as real life.
  bringForward(info.gameweek.id, 200);
  flagReselections();
  applyAutoPicks();
  createLocalProvider().backfillFinished();
  settleAllLeagues();

  const after = get(
    "SELECT COUNT(*) AS count FROM entries WHERE league_id = ? AND status = 'active'", league.id,
  ).count;
  const out = all(
    `SELECT u.display_name, e.eliminated_reason, t.name AS team
     FROM entries e
     JOIN users u ON u.id = e.user_id
     LEFT JOIN picks p ON p.entry_id = e.id AND p.round_number = ?
     LEFT JOIN teams t ON t.id = p.team_id
     WHERE e.league_id = ? AND e.eliminated_round = ?`,
    round, league.id, round,
  );
  return { round, before, after, out };
}

// ------------------------------------------------------------------ modes --

const deadlineIn = flag('deadline');
if (deadlineIn !== undefined) {
  const minutes = Number(deadlineIn) || 10;
  for (const league of leagues()) {
    const context = leagueContext(league);
    const round = context.nextOpenRound;
    if (!round) continue;
    const info = context.roundInfo(round);
    const first = new Date(Date.now() + minutes * 60_000);
    const fixtures = all('SELECT * FROM fixtures WHERE gameweek_id = ? ORDER BY kickoff', info.gameweek.id);
    fixtures.forEach((fixture, index) => {
      run('UPDATE fixtures SET kickoff = ? WHERE id = ?',
        new Date(first.getTime() + index * 30 * 60_000).toISOString(), fixture.id);
    });
    run('UPDATE gameweeks SET deadline = ? WHERE id = ?', first.toISOString(), info.gameweek.id);
    console.log(`${league.name}: round ${round} now closes at ${first.toLocaleTimeString('en-GB')} (${minutes} min).`);
  }
  console.log('\nReminders go out on the next scheduler tick. Anyone who has not picked by then');
  console.log('gets the next club they have not used, alphabetically.');
  process.exit(0);
}

const rounds = flag('advance') ? 1 : Number(flag('rounds') || 0);

if (!rounds) {
  console.log('\nWhere every league is up to:\n');
  leagues().forEach(report);
  console.log('\n  npm run simulate -- --advance       play out the next round');
  console.log('  npm run simulate -- --rounds=5      play out five');
  console.log('  npm run simulate -- --deadline=10   put the next deadline 10 minutes away\n');
  process.exit(0);
}

for (const league of leagues()) {
  console.log(`\n${league.name}`);
  for (let index = 0; index < rounds; index += 1) {
    const current = get('SELECT * FROM leagues WHERE id = ?', league.id);
    if (current.status === 'completed') { console.log('  Competition over.'); break; }

    const result = advanceOnce(current);
    if (result.done) { console.log('  No rounds left in the season.'); break; }

    console.log(`  Round ${result.round}: ${result.before} in → ${result.after} in` +
      (result.out.length ? ` (${result.out.length} out)` : ' (everybody through)'));
    for (const person of result.out.slice(0, 8)) {
      const why = { loss: 'lost', draw: 'drew', void: 'no result', no_pick: 'no pick' }[person.eliminated_reason]
        ?? person.eliminated_reason;
      console.log(`      ${person.display_name.padEnd(18)} ${(person.team ?? '—').padEnd(24)} ${why}`);
    }
    if (result.out.length > 8) console.log(`      …and ${result.out.length - 8} more`);
  }

  const finished = get('SELECT * FROM leagues WHERE id = ?', league.id);
  if (finished.status === 'completed') {
    const winners = all(
      `SELECT u.display_name FROM entries e JOIN users u ON u.id = e.user_id
       WHERE e.league_id = ? AND e.is_winner = 1`,
      league.id,
    );
    console.log(`  Winner${winners.length === 1 ? '' : 's'}: ${winners.map((w) => w.display_name).join(', ')}`);
  }
  const check = verifyLeague(league.id);
  console.log(`  Cross-check: ${check.ok ? 'every result agrees with the fixtures' : `${check.errorCount} PROBLEM(S)`}`);
}

console.log('');
leagues().forEach(report);
console.log('');
