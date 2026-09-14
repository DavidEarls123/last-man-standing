import { get } from '../db/index.js';
import { roundFixturesWithPicks } from './picks.js';
import { leagueContext } from './leagues.js';

/** Connected Server-Sent Events clients, keyed by response object. */
const clients = new Map();

function send(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    clients.delete(res);
  }
}

export function payloadFor(leagueId, requestedRound) {
  const league = get('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!league) return null;
  const context = leagueContext(league);
  const round = requestedRound ?? context.focusRound;
  return {
    leagueId: league.id,
    ...roundFixturesWithPicks(league, round),
    roundInPlay: context.roundInPlay,
    nextOpenRound: context.nextOpenRound,
    updatedAt: new Date().toISOString(),
  };
}

export function addClient(res, { leagueId, round }) {
  clients.set(res, { leagueId, round });
  const payload = payloadFor(leagueId, round);
  if (payload) send(res, 'scores', payload);
  res.on('close', () => clients.delete(res));
}

/**
 * Push the latest scores and pick counts to everyone watching.
 *
 * Viewers cluster on the same handful of league/round pairs on a Saturday
 * afternoon, so each payload is built once and sent to everyone on it.
 */
export function broadcastLive() {
  const built = new Map();
  for (const [res, subscription] of clients) {
    const key = `${subscription.leagueId}:${subscription.round ?? 'current'}`;
    if (!built.has(key)) built.set(key, payloadFor(subscription.leagueId, subscription.round));
    const payload = built.get(key);
    if (payload) send(res, 'scores', payload);
  }
  return clients.size;
}

export function heartbeat() {
  for (const res of clients.keys()) {
    try {
      res.write(': ping\n\n');
    } catch {
      clients.delete(res);
    }
  }
}

export const liveClientCount = () => clients.size;
