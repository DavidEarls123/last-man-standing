import { all } from '../db/index.js';

/**
 * Anything an admin typed themselves. Everything else the league sent on its
 * own — deadline reminders, results, an auto-pick — and the difference matters
 * when you are trying to remember whether you told people something.
 */
const MANUAL_KINDS = new Set(['announcement']);

export const KIND_LABEL = Object.freeze({
  announcement: 'Announcement',
  deadline_reminder: 'Deadline reminder',
  final_call: 'Final call',
  survived: 'Through to the next round',
  eliminated: 'Knocked out',
  reselect_required: 'Asked to pick again',
  auto_pick: 'Club picked for them',
  welcome: 'Welcome',
  config_unlocked: 'Setup reopened',
  change_requested: 'Change requested',
  change_answered: 'Change request answered',
});

const roundOf = (row) => {
  if (!row.meta) return null;
  try { return JSON.parse(row.meta).round ?? null; } catch { return null; }
};

/**
 * One line of news per batch, not one per recipient. A batch is one kind of
 * message, about one league and round, sent in one go.
 */
export function groupNotifications(rows, { limit = 60 } = {}) {
  const batches = new Map();

  for (const row of rows) {
    const round = roundOf(row);
    // To the second, not the millisecond: a loop over sixteen entrants is one
    // send even if it straddles a tick of the clock.
    const second = String(row.scheduled_for ?? '').slice(0, 19);
    const key = [row.kind, row.league_id ?? '-', round ?? '-', second].join('|');
    if (!batches.has(key)) {
      batches.set(key, {
        key,
        kind: row.kind,
        label: KIND_LABEL[row.kind] ?? row.kind,
        manual: MANUAL_KINDS.has(row.kind),
        leagueId: row.league_id ?? null,
        leagueName: row.league_name ?? null,
        round,
        scheduledFor: row.scheduled_for,
        subject: row.subject,
        counts: { total: 0, queued: 0, sent: 0, failed: 0, skipped: 0, email: 0, sms: 0 },
        recipients: [],
      });
    }
    const batch = batches.get(key);
    batch.counts.total += 1;
    batch.counts[row.status] = (batch.counts[row.status] ?? 0) + 1;
    batch.counts[row.channel] = (batch.counts[row.channel] ?? 0) + 1;
    batch.recipients.push({
      id: row.id,
      name: row.display_name,
      channel: row.channel,
      status: row.status,
      subject: row.subject,
      body: row.body,
    });
  }

  return [...batches.values()].slice(0, limit);
}

/** Every message this league has sent, grouped, newest first. */
export function leagueOutbox(leagueId, { limit = 400 } = {}) {
  return groupNotifications(all(
    `SELECT n.*, u.display_name
     FROM notifications n
     JOIN users u ON u.id = n.user_id
     WHERE n.league_id = ?
     ORDER BY n.created_at DESC
     LIMIT ?`,
    leagueId, limit,
  ));
}
