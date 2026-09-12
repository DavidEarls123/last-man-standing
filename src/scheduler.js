import { all, get, run, audit } from './db/index.js';
import { config } from './config.js';
import { nowIso } from './lib/time.js';
import { footballProvider } from './services/football/index.js';
import { settleAllLeagues } from './services/settlement.js';
import { dispatchDueNotifications, queueDeadlineReminders } from './services/notifications.js';
import { broadcastLive, heartbeat } from './services/live.js';
import { leagueContext } from './services/leagues.js';
import { availableTeamsForRound, submitPick } from './services/picks.js';

/**
 * Leagues configured with no_pick_policy = 'random' get an automatic pick at
 * the deadline instead of an elimination.
 */
export function applyAutoPicks() {
  const leagues = all(
    "SELECT * FROM leagues WHERE status IN ('open', 'active') AND no_pick_policy = 'random'",
  );
  let made = 0;
  for (const league of leagues) {
    const context = leagueContext(league);
    // Any round whose deadline has passed but which is not yet settled.
    const rounds = context.rounds.filter((round) => round.deadlinePassed && !round.settled);
    for (const roundInfo of rounds) {
      const entries = all(
        `SELECT e.* FROM entries e
         WHERE e.league_id = ? AND e.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM picks p WHERE p.entry_id = e.id AND p.round_number = ?)`,
        league.id, roundInfo.round,
      );
      for (const entry of entries) {
        const options = availableTeamsForRound(league, entry, roundInfo.round).filter((team) => team.available);
        if (!options.length) continue;
        const choice = options[Math.floor(Math.random() * options.length)];
        submitPick({
          league, entry, round: roundInfo.round, teamId: choice.teamId,
          actorUserId: null, override: true,
        });
        audit(null, 'pick.auto', 'entry', entry.id, { leagueId: league.id, round: roundInfo.round, teamId: choice.teamId });
        made += 1;
      }
    }
  }
  return made;
}

async function tick() {
  try {
    const changed = await footballProvider().refresh();
    applyAutoPicks();
    const settled = settleAllLeagues();
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
