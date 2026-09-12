import { all, get, run } from '../db/index.js';
import { hashPassword } from '../lib/auth.js';
import { nowIso } from '../lib/time.js';
import { seedSeason } from '../db/seed.js';
import { createLocalProvider } from '../services/football/local.js';
import { createLeague, joinLeague, leagueContext } from '../services/leagues.js';
import { availableTeamsForRound, submitPick } from '../services/picks.js';
import { settleRound } from '../services/settlement.js';
import { flag } from './prompt.js';

/**
 * Builds a demo league with a full history so the app can be explored without
 * waiting for real football:  npm run demo
 */
const PASSWORD = 'demo-password-1234';

const NAMES = [
  'Alex Turner', 'Priya Shah', 'Danny Muir', 'Grace O\'Neill', 'Tom Hardy', 'Rachel Kim',
  'Marcus Bell', 'Sinead Byrne', 'Wes Okoro', 'Holly Green', 'Ivan Petrov', 'Jade Foster',
  'Kevin Doyle', 'Lucy Zhang', 'Mo Farah', 'Nina Rossi',
];

async function ensureUser(name, index) {
  const email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`;
  const existing = get('SELECT * FROM users WHERE email = ?', email);
  if (existing) return existing;
  const result = run(
    `INSERT INTO users (email, phone, display_name, password_hash, notify_email, notify_sms, created_at)
     VALUES (?, ?, ?, ?, 1, 0, ?)`,
    email, `+4477009009${String(index).padStart(2, '0')}`, name, await hashPassword(PASSWORD), nowIso(),
  );
  return get('SELECT * FROM users WHERE id = ?', Number(result.lastInsertRowid));
}

/** Did this team win its fixture in an already-played round? */
function teamWon(roundInfo, teamId) {
  const fixture = roundInfo.fixtures.find(
    (candidate) => candidate.home_team_id === teamId || candidate.away_team_id === teamId,
  );
  if (!fixture || fixture.status !== 'finished') return false;
  return fixture.home_team_id === teamId
    ? fixture.home_score > fixture.away_score
    : fixture.away_score > fixture.home_score;
}

const season = seedSeason({ reset: Boolean(flag('reset', false)) });
createLocalProvider().backfillFinished();

const admin = await ensureUser('League Admin', 0);
const existingLeague = get('SELECT * FROM leagues WHERE name = ?', 'The Local Pub LMS');
const league = existingLeague ?? createLeague({
  name: 'The Local Pub LMS',
  seasonId: season.seasonId,
  startGameweek: 1,
  adminUserId: admin.id,
  createdBy: admin.id,
});

const players = [];
for (const [index, name] of NAMES.entries()) {
  const user = await ensureUser(name, index + 1);
  players.push({ user, entry: joinLeague(league, user.id, { force: true }) });
}

// Play the league forwards: everyone picks for each settled round until they go out.
const context = leagueContext(league);
for (const roundInfo of context.rounds) {
  if (!roundInfo.deadlinePassed) break;
  for (const { entry } of players) {
    const current = get('SELECT * FROM entries WHERE id = ?', entry.id);
    if (current.status !== 'active') continue;
    if (get('SELECT 1 FROM picks WHERE entry_id = ? AND round_number = ?', entry.id, roundInfo.round)) continue;
    const options = availableTeamsForRound(league, current, roundInfo.round).filter((team) => team.available);
    if (!options.length) continue;
    // Since these rounds have already been played we know which picks won.
    // Let roughly two thirds of the field survive each round so the demo shows
    // a believable funnel rather than a wipeout.
    const winners = options.filter((team) => teamWon(roundInfo, team.teamId));
    const losers = options.filter((team) => !teamWon(roundInfo, team.teamId));
    const lucky = Math.abs(Math.sin(entry.id * 12.9898 + roundInfo.round * 78.233)) % 1 < 0.68;
    const pool = (lucky && winners.length ? winners : losers.length ? losers : options);
    // Cluster onto a handful of "favourites" the way real entrants do.
    const index = Math.floor(Math.abs(Math.cos(entry.id * roundInfo.round)) * Math.min(4, pool.length));
    submitPick({ league, entry: current, round: roundInfo.round, teamId: pool[index].teamId, actorUserId: null, override: true });
  }
  // Settle just this round — settleAllLeagues would run ahead into rounds
  // whose picks have not been made yet.
  settleRound(league.id, roundInfo.round);
}

// A pick for the round that is still open, from most (not all) survivors.
const refreshed = leagueContext(get('SELECT * FROM leagues WHERE id = ?', league.id));
if (refreshed.nextOpenRound) {
  const survivors = all("SELECT * FROM entries WHERE league_id = ? AND status = 'active'", league.id);
  for (const entry of survivors.slice(0, Math.max(1, survivors.length - 2))) {
    if (get('SELECT 1 FROM picks WHERE entry_id = ? AND round_number = ?', entry.id, refreshed.nextOpenRound)) continue;
    const options = availableTeamsForRound(league, entry, refreshed.nextOpenRound).filter((team) => team.available);
    if (!options.length) continue;
    const index = Math.floor(Math.abs(Math.cos(entry.id)) * Math.min(4, options.length));
    submitPick({ league, entry, round: refreshed.nextOpenRound, teamId: options[index].teamId, actorUserId: null, override: true });
  }
}

const survivors = get("SELECT COUNT(*) AS count FROM entries WHERE league_id = ? AND status = 'active'", league.id).count;
console.log(`Demo league "${league.name}" ready — join code ${get('SELECT join_code FROM leagues WHERE id = ?', league.id).join_code}`);
console.log(`  ${players.length} entrants, ${survivors} still standing, next round ${refreshed.nextOpenRound ?? 'n/a'}`);
console.log(`  League admin: ${admin.email}`);
console.log(`  Players: ${players[1].user.email} … (password for every demo account: ${PASSWORD})`);
