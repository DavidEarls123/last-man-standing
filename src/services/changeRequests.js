import { all, get, run, audit } from '../db/index.js';
import { config } from '../config.js';
import { nowIso } from '../lib/time.js';
import { queueDirect } from './notifications.js';

/**
 * A launched league is frozen to its own admin — that is the whole point of
 * the lock, because entrants signed up to the rules as they stood. But a
 * genuine mistake still has to be fixable, so the admin asks rather than
 * overrides, and the platform admin is told the moment they do.
 */

const shape = (row) => ({
  id: row.id,
  leagueId: row.league_id,
  leagueName: row.league_name ?? null,
  message: row.message,
  status: row.status,
  outcome: row.outcome,
  requestedBy: row.requested_by,
  requestedByName: row.requested_by_name ?? null,
  resolvedByName: row.resolved_by_name ?? null,
  resolvedAt: row.resolved_at,
  createdAt: row.created_at,
});

export const platformAdmins = () =>
  all("SELECT * FROM users WHERE is_super_admin = 1 AND status = 'active'");

/** Raise a request and tell every platform admin about it. */
export function requestChange({ league, user, message }) {
  const result = run(
    `INSERT INTO change_requests (league_id, requested_by, message, status, created_at)
     VALUES (?, ?, ?, 'open', ?)`,
    league.id, user.id, message, nowIso(),
  );
  const id = Number(result.lastInsertRowid);
  audit(user.id, 'league.change_requested', 'league', league.id, { requestId: id });

  const admins = platformAdmins();
  for (const admin of admins) {
    queueDirect(admin, {
      kind: 'change_requested',
      league,
      subject: `${league.name}: the league admin has asked for a change`,
      body: [
        `Hi ${admin.display_name},`,
        '',
        `${user.display_name} runs ${league.name}, which is launched and locked.`,
        'They have asked for the following change:',
        '',
        message,
        '',
        'You can either make the change yourself, or reopen the setup so they can.',
        '',
        `${config.publicUrl}/leagues/${league.id}/admin`,
      ].join('\n'),
    });
  }
  return { request: shape(get('SELECT * FROM change_requests WHERE id = ?', id)), notified: admins.length };
}

const LIST = `
  SELECT c.*, l.name AS league_name,
         u.display_name AS requested_by_name,
         r.display_name AS resolved_by_name
    FROM change_requests c
    JOIN leagues l ON l.id = c.league_id
    JOIN users u ON u.id = c.requested_by
    LEFT JOIN users r ON r.id = c.resolved_by
`;

export const changeRequestsFor = (leagueId) =>
  all(`${LIST} WHERE c.league_id = ? ORDER BY c.created_at DESC`, leagueId).map(shape);

/** Everything still waiting on a platform admin, across every league. */
export const openChangeRequests = () =>
  all(`${LIST} WHERE c.status = 'open' ORDER BY c.created_at`).map(shape);

/**
 * Close a request off and tell the admin who raised it. `status` is 'resolved'
 * when something was done and 'declined' when it was not — either way they hear
 * back, because an unanswered request is how an admin ends up overriding.
 */
export function resolveChangeRequest({ id, actor, status = 'resolved', outcome = null }) {
  const request = get(`${LIST} WHERE c.id = ?`, id);
  if (!request || request.status !== 'open') return null;

  run(
    'UPDATE change_requests SET status = ?, outcome = ?, resolved_by = ?, resolved_at = ? WHERE id = ?',
    status, outcome, actor.id, nowIso(), id,
  );
  audit(actor.id, `league.change_${status}`, 'league', request.league_id, { requestId: id, outcome });

  const league = get('SELECT * FROM leagues WHERE id = ?', request.league_id);
  const asker = get('SELECT * FROM users WHERE id = ?', request.requested_by);
  if (asker) {
    queueDirect(asker, {
      kind: 'change_answered',
      league,
      subject: `${league.name}: your change request has been ${status}`,
      body: [
        `Hi ${asker.display_name},`,
        '',
        `You asked: ${request.message}`,
        '',
        status === 'resolved'
          ? `${actor.display_name} has dealt with it.`
          : `${actor.display_name} has not made this change.`,
        ...(outcome ? ['', outcome] : []),
        '',
        `${config.publicUrl}/leagues/${league.id}/admin`,
      ].join('\n'),
    });
  }
  return shape(get(`${LIST} WHERE c.id = ?`, id));
}

/** Reopening the setup answers whatever was outstanding on that league. */
export function resolveOpenRequestsFor(leagueId, actor, outcome) {
  const open = all("SELECT id FROM change_requests WHERE league_id = ? AND status = 'open'", leagueId);
  for (const row of open) resolveChangeRequest({ id: row.id, actor, outcome });
  return open.length;
}
