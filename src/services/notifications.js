import { all, get, run, getSetting } from '../db/index.js';
import { config } from '../config.js';
import { humaniseDuration, nowIso } from '../lib/time.js';
import { leagueContext } from './leagues.js';
import { outstandingOpeningRounds } from '../domain/rules.js';

export const NOTIFICATION_DEFAULTS = Object.freeze({
  enabled: true,
  // How long before a deadline to nudge entrants who have not picked yet.
  reminderOffsetsMinutes: [2880, 1440, 120],
  // Also nudge everyone (not just non-pickers) at this offset. null disables.
  finalCallOffsetMinutes: 60,
  resultNotices: true,
  channels: { email: true, sms: true },
});

export function notificationSettings() {
  const stored = getSetting('notifications', {});
  return {
    ...NOTIFICATION_DEFAULTS,
    ...stored,
    channels: { ...NOTIFICATION_DEFAULTS.channels, ...(stored.channels || {}) },
  };
}

/**
 * Which channels a message may go out on. Three switches have to agree: the
 * platform setting, the league's own (texts cost money, so a league can be
 * email-only), and the player's own preference.
 */
function channelsFor(user, settings, league = null) {
  const smsAllowed = settings.channels.sms && (league ? league.sms_enabled !== 0 : true);
  const channels = [];
  if (settings.channels.email && user.notify_email && user.email) channels.push('email');
  if (smsAllowed && user.notify_sms && user.phone) channels.push('sms');
  // Always fall back to whatever contact detail we hold, so nobody misses a deadline.
  if (channels.length === 0) {
    if (user.email && settings.channels.email) channels.push('email');
    else if (user.phone && smsAllowed) channels.push('sms');
  }
  return channels;
}

function enqueue({ user, league, kind, dedupeKey, subject, body, scheduledFor, settings, meta = null, force = false }) {
  if (!settings.enabled && !force) return 0;
  let queued = 0;
  for (const channel of channelsFor(user, settings, league)) {
    const result = run(
      `INSERT OR IGNORE INTO notifications
         (user_id, league_id, kind, channel, dedupe_key, meta, subject, body, scheduled_for, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      user.id, league?.id ?? null, kind, channel, `${dedupeKey}:${channel}`,
      meta === null ? null : JSON.stringify(meta),
      subject, body, scheduledFor, nowIso(),
    );
    queued += Number(result.changes);
  }
  return queued;
}

/**
 * Queue deadline reminders for every league with an upcoming round. Runs on a
 * timer; the dedupe key keeps repeat runs idempotent.
 */
export function queueDeadlineReminders() {
  const settings = notificationSettings();
  if (!settings.enabled) return 0;

  const leagues = all('SELECT * FROM leagues WHERE status IN (\'open\', \'active\')');
  let queued = 0;

  for (const league of leagues) {
    const context = leagueContext(league);
    const round = context.nextOpenRound;
    if (!round) continue;
    const roundInfo = context.roundInfo(round);
    const deadlineMs = new Date(roundInfo.deadline).getTime();

    const offsets = [...settings.reminderOffsetsMinutes];
    if (settings.finalCallOffsetMinutes) offsets.push(settings.finalCallOffsetMinutes);

    for (const offset of new Set(offsets)) {
      const sendAt = deadlineMs - offset * 60_000;
      if (sendAt < Date.now() - 30 * 60_000) continue; // too late to be useful
      const finalCall = offset === settings.finalCallOffsetMinutes;

      const entries = all(
        `SELECT e.*, u.id AS uid, u.email, u.phone, u.display_name, u.notify_email, u.notify_sms
         FROM entries e JOIN users u ON u.id = e.user_id
         WHERE e.league_id = ? AND e.status = 'active'`,
        league.id,
      );

      for (const entry of entries) {
        const hasPick = get(
          'SELECT 1 FROM picks WHERE entry_id = ? AND round_number = ?', entry.id, round,
        );
        const owesOpening = round === 1 && league.opening_picks > 1 && get(
          `SELECT COUNT(*) AS count FROM picks WHERE entry_id = ? AND round_number <= ?`,
          entry.id, league.opening_picks,
        ).count < league.opening_picks;
        if (hasPick && !owesOpening && !finalCall) continue;

        // Before kick off the whole opening block is due, not just round 1.
        const owed = round === 1 && league.opening_picks > 1
          ? outstandingOpeningRounds(
              all('SELECT round_number FROM picks WHERE entry_id = ?', entry.id), league.opening_picks,
            )
          : [];
        const what = owed.length > 1
          ? `your opening picks (rounds ${owed.join(', ')})`
          : `your round ${round} pick`;
        const subject = hasPick && owed.length === 0
          ? `${league.name}: round ${round} deadline in ${humaniseDuration(offset)}`
          : `${league.name}: ${what} due in ${humaniseDuration(offset)}`;
        const consequence = league.no_pick_policy === 'eliminate'
          ? 'or you are out.'
          : 'or you will be given the next club you have not used, alphabetically.';
        const body = [
          `Hi ${entry.display_name},`,
          '',
          hasPick && owed.length === 0
            ? `Round ${round} of ${league.name} locks in ${humaniseDuration(offset)}. Your pick is in — good luck.`
            : `${league.name} still needs ${what}. Get it in within ${humaniseDuration(offset)} ${consequence}`,
          '',
          `Deadline: ${roundInfo.deadline} — the first kick off of the gameweek, the same for everyone.`,
          `${config.publicUrl}/leagues/${league.id}`,
        ].join('\n');

        queued += enqueue({
          user: { id: entry.uid, email: entry.email, phone: entry.phone, notify_email: entry.notify_email, notify_sms: entry.notify_sms },
          league,
          kind: 'deadline_reminder',
          dedupeKey: `reminder:${league.id}:${round}:${entry.uid}:${offset}`,
          subject,
          body,
          scheduledFor: new Date(Math.max(sendAt, Date.now())).toISOString(),
          settings,
          meta: { round, entryId: entry.id, needsPick: !hasPick },
        });
      }
    }
  }
  return queued;
}

const userForEntry = (entryId) =>
  get(
    `SELECT u.id, u.email, u.phone, u.display_name, u.notify_email, u.notify_sms
     FROM entries e JOIN users u ON u.id = e.user_id WHERE e.id = ?`,
    entryId,
  );

const REASON_COPY = {
  loss: (team) => `${team} lost`,
  draw: (team) => `${team} drew — a draw is not a win`,
  void: (team) => `${team}'s fixture did not produce a result`,
  no_pick: () => 'no pick was made before the deadline',
};

/** Tell someone which club they were handed after missing a deadline. */
export function queueAutoPickNotices(league, items) {
  const settings = notificationSettings();
  if (!settings.resultNotices) return 0;
  let queued = 0;
  for (const { entry, round, teamName, deadline, opening } of items) {
    const user = userForEntry(entry.id);
    if (!user) continue;
    queued += enqueue({
      user, league,
      kind: 'auto_pick',
      dedupeKey: `autopick:${league.id}:${round}:${entry.id}`,
      subject: `${league.name}: ${teamName} picked for you in round ${round}`,
      body: [
        `Hi ${user.display_name},`,
        '',
        opening
          ? `Entries closed before your opening picks were all in, so the league rules handed you the`
          : `Round ${round} closed${deadline ? ` at ${deadline}` : ''} without a pick from you, so the league rules handed you the`,
        `next club you had not used, alphabetically: ${teamName} for round ${round}.`,
        opening ? 'You can still change it any time before that gameweek kicks off.' : '',
        '',
        `${config.publicUrl}/leagues/${league.id}`,
      ].filter(Boolean).join('\n'),
      scheduledFor: nowIso(),
      settings,
    });
  }
  return queued;
}

export function queueEliminationNotices(league, eliminated, round) {
  const settings = notificationSettings();
  if (!settings.resultNotices) return 0;
  let queued = 0;
  for (const { entry, reason, teamName } of eliminated) {
    const user = userForEntry(entry.id);
    if (!user) continue;
    const detail = (REASON_COPY[reason] || (() => 'your pick did not win'))(teamName || 'your pick');
    queued += enqueue({
      user, league,
      kind: 'eliminated',
      dedupeKey: `eliminated:${league.id}:${round}:${entry.id}`,
      subject: `${league.name}: you are out in round ${round}`,
      body: [
        `Hi ${user.display_name},`,
        '',
        `Bad news — ${detail}, so your run in ${league.name} ends at round ${round}.`,
        'You can still follow the league and see how everyone else gets on.',
        '',
        `${config.publicUrl}/leagues/${league.id}`,
      ].join('\n'),
      scheduledFor: nowIso(),
      settings,
    });
  }
  return queued;
}

export function queueSurvivalNotices(league, survived, round, leagueComplete) {
  const settings = notificationSettings();
  if (!settings.resultNotices || leagueComplete) return 0;
  let queued = 0;
  for (const { entry, teamName } of survived) {
    const user = userForEntry(entry.id);
    if (!user) continue;
    queued += enqueue({
      user, league,
      kind: 'survived',
      dedupeKey: `survived:${league.id}:${round}:${entry.id}`,
      subject: `${league.name}: through to round ${round + 1}`,
      body: [
        `Hi ${user.display_name},`,
        '',
        `${teamName ?? 'Your pick'} won, so you are through to round ${round + 1} of ${league.name}.`,
        'Remember you cannot pick that team again this cycle.',
        '',
        `${config.publicUrl}/leagues/${league.id}`,
      ].join('\n'),
      scheduledFor: nowIso(),
      settings,
    });
  }
  return queued;
}

/**
 * "Your team's game is off — pick again." Sent as soon as a fixture is called
 * off, with however long is left to choose a replacement.
 */
export function queueReselectionNotices(items) {
  const settings = notificationSettings();
  let queued = 0;
  for (const { league, pick, round, deadline, teamName } of items) {
    const user = userForEntry(pick.entry_id);
    if (!user) continue;
    queued += enqueue({
      user, league,
      kind: 'reselect_required',
      dedupeKey: `reselect:${league.id}:${round}:${pick.entry_id}:${pick.team_id}`,
      subject: `${league.name}: ${teamName}'s game is off — pick again`,
      body: [
        `Hi ${user.display_name},`,
        '',
        `${teamName}'s round ${round} fixture has been called off, so your pick no longer counts.`,
        deadline
          ? `Choose another team before ${deadline} — anything in the gameweek that has not kicked off yet.`
          : 'There are no games left to switch to in this gameweek, so the round is void for you and you go through.',
        deadline ? `${teamName} goes back in your pool, so you can still use them later.` : '',
        '',
        `${config.publicUrl}/leagues/${league.id}/pick`,
      ].filter(Boolean).join('\n'),
      scheduledFor: nowIso(),
      settings,
      meta: { round, entryId: pick.entry_id },
      force: true,
    });
  }
  return queued;
}

export function queueWinnerNotices(league, winnerEntryIds, round, reason) {
  const settings = notificationSettings();
  if (!settings.resultNotices) return 0;
  let queued = 0;
  const shared = winnerEntryIds.length > 1;
  for (const entryId of winnerEntryIds) {
    const user = userForEntry(entryId);
    if (!user) continue;
    queued += enqueue({
      user, league,
      kind: 'winner',
      dedupeKey: `winner:${league.id}:${entryId}`,
      subject: `${league.name}: you won!`,
      body: [
        `Hi ${user.display_name},`,
        '',
        shared
          ? `Every remaining entrant went out in round ${round}, so the win in ${league.name} is shared between you and ${winnerEntryIds.length - 1} other${winnerEntryIds.length === 2 ? '' : 's'}.`
          : `You are the last one standing in ${league.name} after round ${round}. Congratulations!`,
        reason === 'all_out_same_round' ? '' : '',
        `${config.publicUrl}/leagues/${league.id}`,
      ].filter(Boolean).join('\n'),
      scheduledFor: nowIso(),
      settings,
    });
  }
  return queued;
}

/**
 * Queue a one-off message (password resets, admin announcements). Always sent,
 * even when routine competition notices are switched off.
 */
export function queueDirect(user, { kind, subject, body, league = null, dedupeKey = null }) {
  return enqueue({
    user, league, kind,
    dedupeKey: dedupeKey ?? `${kind}:${user.id}:${Date.now()}`,
    subject, body,
    scheduledFor: nowIso(),
    settings: notificationSettings(),
    force: true,
  });
}

// ---------------------------------------------------------------- delivery --

let mailer = null;
async function sendEmail(to, subject, body) {
  if (config.email.provider === 'smtp' && config.email.smtpUrl) {
    if (!mailer) {
      const nodemailer = await import('nodemailer');
      mailer = nodemailer.default.createTransport(config.email.smtpUrl);
    }
    await mailer.sendMail({ from: config.email.from, to, subject, text: body });
    return;
  }
  console.log(`\n[email:console] to=${to}\nsubject=${subject}\n${body}\n`);
}

async function sendSms(to, body) {
  if (config.sms.provider === 'twilio' && config.sms.accountSid) {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.sms.accountSid}/Messages.json`;
    const auth = Buffer.from(`${config.sms.accountSid}:${config.sms.authToken}`).toString('base64');
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: config.sms.from, Body: body }),
    });
    if (!response.ok) throw new Error(`Twilio ${response.status}: ${await response.text()}`);
    return;
  }
  console.log(`\n[sms:console] to=${to}\n${body}\n`);
}

/**
 * A reminder queued days ahead can be overtaken by events — the player picks,
 * or goes out — so check it still applies before it goes anywhere.
 */
function isStale(notification) {
  if (notification.kind !== 'deadline_reminder' || !notification.meta) return false;
  let meta;
  try {
    meta = JSON.parse(notification.meta);
  } catch {
    return false;
  }
  const entry = get('SELECT status FROM entries WHERE id = ?', meta.entryId);
  if (!entry || entry.status !== 'active') return true;
  if (!meta.needsPick) return false;
  return Boolean(get('SELECT 1 FROM picks WHERE entry_id = ? AND round_number = ?', meta.entryId, meta.round));
}

/** Send everything that is due. Called on a timer by the scheduler. */
export async function dispatchDueNotifications({ limit = 50 } = {}) {
  const due = all(
    `SELECT n.*, u.email, u.phone FROM notifications n
     JOIN users u ON u.id = n.user_id
     WHERE n.status = 'queued' AND n.scheduled_for <= ?
     ORDER BY n.scheduled_for LIMIT ?`,
    nowIso(), limit,
  );

  let sent = 0;
  for (const notification of due) {
    if (isStale(notification)) {
      run("UPDATE notifications SET status = 'skipped', error = ? WHERE id = ?", 'no longer relevant', notification.id);
      continue;
    }
    const destination = notification.channel === 'email' ? notification.email : notification.phone;
    if (!destination) {
      run('UPDATE notifications SET status = \'skipped\', error = ? WHERE id = ?', 'no destination', notification.id);
      continue;
    }
    try {
      if (notification.channel === 'email') {
        await sendEmail(destination, notification.subject, notification.body);
      } else {
        await sendSms(destination, `${notification.subject}\n\n${notification.body}`);
      }
      run('UPDATE notifications SET status = \'sent\', sent_at = ? WHERE id = ?', nowIso(), notification.id);
      sent += 1;
    } catch (error) {
      run('UPDATE notifications SET status = \'failed\', error = ? WHERE id = ?', String(error.message), notification.id);
    }
  }
  return sent;
}
