import { all, audit, get } from './db/index.js';
import { config } from './config.js';
import { footballProvider } from './services/football/index.js';
import { flagReselections, settleAllLeagues } from './services/settlement.js';
import { dispatchDueNotifications, queueAutoPickNotices, queueDeadlineReminders } from './services/notifications.js';
import { broadcastLive, heartbeat } from './services/live.js';
import { leagueContext } from './services/leagues.js';
import { submitPick, usedPicks } from './services/picks.js';
import { nextAlphabeticalTeam } from './domain/rules.js';

/**
 * Miss a deadline and the league hands you the next club you have not used,
 * in alphabetical order — no pick, but no automatic exit either. Leagues set
 * to `eliminate` skip this and go out at settlement instead.
 */
export function applyAutoPicks() {
  const leagues = all(
    "SELECT * FROM leagues WHERE status IN ('open', 'active') AND no_pick_policy = 'auto_alphabetical'",
  );
  let made = 0;
  for (const league of leagues) {
    const context = leagueContext(league);
    // Any round whose deadline has passed but which is not yet settled...
    const rounds = context.rounds.filter((round) => round.deadlinePassed && !round.settled);
    // ...plus, once entries have closed, the rest of the opening block. Those
    // rounds were due up front even though their own kick offs are still ahead.
    if (context.entryClosed) {
      for (const roundInfo of context.rounds) {
        if (roundInfo.round > league.opening_picks) break;
        if (roundInfo.settled || rounds.includes(roundInfo)) continue;
        rounds.push(roundInfo);
      }
      rounds.sort((a, b) => a.round - b.round);
    }
    for (const roundInfo of rounds) {
      const entries = all(
        `SELECT e.* FROM entries e
         WHERE e.league_id = ? AND e.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM picks p WHERE p.entry_id = e.id AND p.round_number = ?)`,
        league.id, roundInfo.round,
      );
      if (!entries.length) continue;

      const playable = new Set();
      for (const fixture of roundInfo.fixtures) {
        if (fixture.status === 'postponed' || fixture.status === 'abandoned') continue;
        playable.add(fixture.home_team_id);
        playable.add(fixture.away_team_id);
      }

      const assigned = [];
      for (const entry of entries) {
        const team = nextAlphabeticalTeam(
          context.teams, usedPicks(entry.id), roundInfo.round, context.teamCount || 1,
          (teamId) => playable.has(teamId),
        );
        if (!team) continue;
        submitPick({
          league, entry, round: roundInfo.round, teamId: team.id,
          actorUserId: null, override: true, autoAssigned: true,
        });
        audit(null, 'pick.auto', 'entry', entry.id, {
          leagueId: league.id, round: roundInfo.round, teamId: team.id, rule: 'alphabetical',
        });
        assigned.push({
          entry, round: roundInfo.round, teamName: team.name, deadline: roundInfo.deadline,
          opening: roundInfo.round <= league.opening_picks && context.entryClosed,
        });
        made += 1;
      }
      if (assigned.length) queueAutoPickNotices(league, assigned);
    }

    // A reselection that ran out of time is a missed deadline like any other.
    // Their club's game was called off, they were asked to pick again, and the
    // last replacement fixture has now kicked off — so hand them the next club
    // they have not used, exactly as if they had never picked at all.
    made += assignLapsedReselections(league, context);
  }
  return made;
}

function assignLapsedReselections(league, context) {
  const now = Date.now();
  let made = 0;

  for (const roundInfo of context.rounds) {
    if (roundInfo.settled) continue;
    const lapsed = all(
      `SELECT p.*, e.id AS entry_row_id FROM picks p
       JOIN entries e ON e.id = p.entry_id
       WHERE p.league_id = ? AND p.round_number = ? AND p.needs_reselect = 1
         AND p.reselect_deadline IS NOT NULL AND e.status = 'active'`,
      league.id, roundInfo.round,
    ).filter((pick) => new Date(pick.reselect_deadline).getTime() <= now);
    if (!lapsed.length) continue;

    // Their own club is not an option: its game is the one that was called off.
    const playable = new Set();
    for (const fixture of roundInfo.fixtures) {
      if (fixture.status === 'postponed' || fixture.status === 'abandoned') continue;
      playable.add(fixture.home_team_id);
      playable.add(fixture.away_team_id);
    }

    const assigned = [];
    for (const pick of lapsed) {
      const entry = get('SELECT * FROM entries WHERE id = ?', pick.entry_id);
      const team = nextAlphabeticalTeam(
        context.teams, usedPicks(entry.id), roundInfo.round, context.teamCount || 1,
        (teamId) => playable.has(teamId),
      );
      // Nothing left to give them: the void stands, and the void policy decides.
      if (!team) continue;
      submitPick({
        league, entry, round: roundInfo.round, teamId: team.id,
        actorUserId: null, override: true, autoAssigned: true,
      });
      audit(null, 'pick.auto', 'entry', entry.id, {
        leagueId: league.id, round: roundInfo.round, teamId: team.id, rule: 'alphabetical_after_reselect',
      });
      assigned.push({
        entry, round: roundInfo.round, teamName: team.name, deadline: pick.reselect_deadline,
        reselection: true,
      });
      made += 1;
    }
    if (assigned.length) queueAutoPickNotices(league, assigned);
  }
  return made;
}

async function tick() {
  try {
    const changed = await footballProvider().refresh();
    // Called-off games open a reselection before anything else is decided.
    const reselections = flagReselections();
    applyAutoPicks();
    const settled = settleAllLeagues();
    if (reselections) console.log(`[scheduler] opened ${reselections} reselection(s)`);
    if (changed.length || settled.length) broadcastLive();
    if (settled.length) {
      console.log(`[scheduler] settled ${settled.length} round(s)`);
    }
  } catch (error) {
    console.error('[scheduler] fixture refresh failed:', error.message);
  }
}

async function notificationTick() {
  try {
    queueDeadlineReminders();
    await dispatchDueNotifications();
  } catch (error) {
    console.error('[scheduler] notification run failed:', error.message);
  }
}

export function startScheduler() {
  const timers = [
    setInterval(tick, Math.max(10, config.football.pollSeconds) * 1000),
    setInterval(notificationTick, 60_000),
    setInterval(heartbeat, 25_000),
  ];
  for (const timer of timers) timer.unref?.();
  tick();
  notificationTick();
  return () => timers.forEach(clearInterval);
}
