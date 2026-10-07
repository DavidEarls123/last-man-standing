import express from 'express';
import { z } from 'zod';
import { all, run } from '../db/index.js';
import { parse, wrap } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { KIND_LABEL } from '../services/outbox.js';
import { nowIso } from '../lib/time.js';

export const inboxRouter = express.Router();
inboxRouter.use(requireAuth);

/**
 * Everything this account has been sent, readable in the app.
 *
 * With no mail server configured nothing actually leaves the machine, so
 * without this the only way to see a deadline reminder is to read the terminal
 * the server is running in — which the player, on their own computer, cannot
 * do. It is also just a sensible thing to have: "what was I told, and when".
 *
 * A message queued to both email and text is one message here. The channel is
 * how it would travel, not what it says.
 */
const baseKey = (row) => {
  const suffix = `:${row.channel}`;
  return row.dedupe_key.endsWith(suffix)
    ? row.dedupe_key.slice(0, -suffix.length)
    : row.dedupe_key;
};

function messagesFor(userId, { limit = 100 } = {}) {
  const rows = all(
    `SELECT n.*, l.name AS league_name
       FROM notifications n
       LEFT JOIN leagues l ON l.id = n.league_id
      WHERE n.user_id = ?
      ORDER BY n.scheduled_for DESC, n.id DESC`,
    userId,
  );

  const grouped = new Map();
  for (const row of rows) {
    const key = baseKey(row);
    const existing = grouped.get(key);
    // Prefer the email copy: same words, and the one people picture receiving.
    if (!existing || (existing.channel !== 'email' && row.channel === 'email')) {
      grouped.set(key, { ...row, channels: existing ? [...existing.channels, row.channel] : [row.channel] });
    } else {
      existing.channels.push(row.channel);
    }
    // Read on any copy is read.
    const entry = grouped.get(key);
    entry.read_at = entry.read_at ?? row.read_at;
  }

  return [...grouped.values()].slice(0, limit).map((row) => ({
    id: row.id,
    kind: row.kind,
    label: KIND_LABEL[row.kind] ?? row.kind,
    leagueId: row.league_id,
    leagueName: row.league_name,
    subject: row.subject,
    body: row.body,
    channels: [...new Set(row.channels)],
    // 'sent' here means the platform dispatched it; with no mail server that
    // means it was printed to the server's console, not that it arrived.
    status: row.status,
    sentAt: row.sent_at,
    scheduledFor: row.scheduled_for,
    read: Boolean(row.read_at),
  }));
}

inboxRouter.get('/', wrap(async (req, res) => {
  const messages = messagesFor(req.user.id);
  res.json({ messages, unread: messages.filter((message) => !message.read).length });
}));

/** Mark messages read. No ids means all of them. */
inboxRouter.post('/read', wrap(async (req, res) => {
  const body = parse(z.object({ ids: z.array(z.number().int()).max(200).optional() }), req.body ?? {});
  if (!body.ids) {
    run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', nowIso(), req.user.id);
  } else {
    for (const id of body.ids) {
      // Both channels of the same message, so reading one does not leave its
      // twin bolding the badge.
      const [row] = all('SELECT * FROM notifications WHERE id = ? AND user_id = ?', id, req.user.id);
      if (!row) continue;
      run(
        `UPDATE notifications SET read_at = ?
          WHERE user_id = ? AND read_at IS NULL AND (dedupe_key = ? OR dedupe_key LIKE ?)`,
        nowIso(), req.user.id, row.dedupe_key, `${baseKey(row)}:%`,
      );
    }
  }
  const messages = messagesFor(req.user.id);
  res.json({ unread: messages.filter((message) => !message.read).length });
}));
