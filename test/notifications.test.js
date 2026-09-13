import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-notify-'));
process.env.DATABASE_FILE = path.join(tmp, 'test.sqlite');
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';

const { all, get, run, setSetting } = await import('../src/db/index.js');
const { seedSeason } = await import('../src/db/seed.js');
const { createLeague, joinLeague, leagueContext } = await import('../src/services/leagues.js');
const { submitPick } = await import('../src/services/picks.js');
const notifications = await import('../src/services/notifications.js');
const { applyAutoPicks } = await import('../src/scheduler.js');

const season = seedSeason({
  seasonName: 'notify-season',
  startDate: new Date(Date.now() + 3 * 86_400_000),
  reset: true,
});

function makeUser(name, { email = true, phone = false } = {}) {
  const result = run(
    `INSERT INTO users (email, phone, display_name, password_hash, notify_email, notify_sms, created_at)
     VALUES (?, ?, ?, 'x', ?, ?, datetime('now'))`,
    email ? `${name}@example.com` : null,
    phone ? `+4477009${String(1000 + Math.floor(Math.random() * 8999))}` : null,
    name, email ? 1 : 0, phone ? 1 : 0,
  );
  return get('SELECT * FROM users WHERE id = ?', Number(result.lastInsertRowid));
}

test('deadline reminders follow the offsets the super admin sets', () => {
  setSetting('notifications', {
    enabled: true,
    reminderOffsetsMinutes: [2880, 60],
    finalCallOffsetMinutes: null,
    resultNotices: true,
    channels: { email: true, sms: true },
  });

  const owner = makeUser('owner');
  const league = createLeague({
    name: 'Reminders', seasonId: season.seasonId, startGameweek: 1, createdBy: owner.id,
    openingPicks: 3,
  });
  const player = makeUser('reminderplayer');
  joinLeague(league, player.id);

  notifications.queueDeadlineReminders();
  const queued = all('SELECT * FROM notifications WHERE user_id = ? ORDER BY scheduled_for', player.id);
  assert.equal(queued.length, 2, 'one reminder per configured offset');

  const deadline = new Date(leagueContext(league).entryDeadline).getTime();
  const offsets = queued
    .map((row) => Math.round((deadline - new Date(row.scheduled_for).getTime()) / 60_000))
    .sort((a, b) => b - a);
  assert.deepEqual(offsets, [2880, 60]);
  assert.match(queued[0].subject, /opening picks \(rounds 1, 2, 3\)/i,
    'before kick off the whole opening block is chased, not just round 1');

  // Running again must not duplicate them.
  notifications.queueDeadlineReminders();
  assert.equal(all('SELECT * FROM notifications WHERE user_id = ?', player.id).length, 2);
});

test('a league with no opening block just chases the round coming up', () => {
  const owner = makeUser('owner1b');
  const league = createLeague({
    name: 'Week by week', seasonId: season.seasonId, startGameweek: 1, createdBy: owner.id,
  });
  const player = makeUser('weekly');
  joinLeague(league, player.id);

  notifications.queueDeadlineReminders();
  const queued = all('SELECT * FROM notifications WHERE user_id = ?', player.id);
  assert.ok(queued.length > 0);
  assert.match(queued[0].subject, /round 1 pick due/i);
});

test('a reminder is dropped if the player picks before it is due', async () => {
  const owner = makeUser('owner2');
  const league = createLeague({
    name: 'Stale reminders', seasonId: season.seasonId, startGameweek: 1, createdBy: owner.id,
  });
  const player = makeUser('procrastinator');
  const entry = joinLeague(league, player.id);

  notifications.queueDeadlineReminders();
  const queued = all('SELECT * FROM notifications WHERE user_id = ?', player.id);
  assert.ok(queued.length > 0);

  // Make the reminder due, then pick anyway.
  run("UPDATE notifications SET scheduled_for = datetime('now', '-1 minute') WHERE user_id = ?", player.id);
  const teams = all('SELECT * FROM teams WHERE season_id = ? LIMIT 1', season.seasonId);
  submitPick({ league, entry, round: 1, teamId: teams[0].id, actorUserId: player.id });

  await notifications.dispatchDueNotifications();
  const after = all('SELECT status FROM notifications WHERE user_id = ?', player.id);
  assert.ok(after.every((row) => row.status === 'skipped'), 'nothing nagging a player who has picked');
});

test('results notices go to the channels each player has turned on', async () => {
  setSetting('notifications', {
    enabled: true, reminderOffsetsMinutes: [60], finalCallOffsetMinutes: null,
    resultNotices: true, channels: { email: true, sms: true },
  });
  const owner = makeUser('owner3');
  const league = createLeague({
    name: 'Both channels', seasonId: season.seasonId, startGameweek: 2, createdBy: owner.id,
  });
  const player = makeUser('bothchannels', { email: true, phone: true });
  const entry = joinLeague(league, player.id);

  notifications.queueEliminationNotices(league, [{ entry, reason: 'loss', teamName: 'Everton' }], 1);
  const queued = all('SELECT * FROM notifications WHERE user_id = ? AND kind = ?', player.id, 'eliminated');
  assert.deepEqual(queued.map((row) => row.channel).sort(), ['email', 'sms']);
  assert.match(queued[0].body, /Everton lost/);

  await notifications.dispatchDueNotifications();
  assert.ok(
    all('SELECT status FROM notifications WHERE user_id = ? AND kind = ?', player.id, 'eliminated')
      .every((row) => row.status === 'sent'),
  );
});

test('switching notifications off queues nothing', () => {
  setSetting('notifications', { enabled: false, reminderOffsetsMinutes: [60], resultNotices: false });
  const owner = makeUser('owner4');
  const league = createLeague({
    name: 'Quiet', seasonId: season.seasonId, startGameweek: 3, createdBy: owner.id,
  });
  const player = makeUser('quiet');
  joinLeague(league, player.id);
  assert.equal(notifications.queueDeadlineReminders(), 0);
  assert.equal(all('SELECT * FROM notifications WHERE user_id = ?', player.id).length, 0);
});

test('missing a deadline hands over the next unused club alphabetically', () => {
  const owner = makeUser('owner5');
  // Start in the past so the round 1 deadline has already gone.
  const past = seedSeason({
    seasonName: 'autopick-season',
    startDate: new Date(Date.now() - 21 * 86_400_000),
    reset: true,
  });
  const league = createLeague({
    name: 'Auto pickers', seasonId: past.seasonId, startGameweek: 1, createdBy: owner.id,
  });
  assert.equal(league.no_pick_policy, 'auto_alphabetical', 'the default for a new league');

  const player = makeUser('forgetful');
  const entry = joinLeague(league, player.id, { force: true });

  assert.ok(applyAutoPicks() >= 1);
  const pick = get(
    `SELECT t.name, p.auto_assigned FROM picks p JOIN teams t ON t.id = p.team_id
     WHERE p.entry_id = ? AND p.round_number = 1`,
    entry.id,
  );
  const alphabeticallyFirst = get(
    'SELECT name FROM teams WHERE season_id = ? ORDER BY name LIMIT 1', past.seasonId,
  ).name;
  assert.equal(pick.name, alphabeticallyFirst);
  assert.equal(pick.auto_assigned, 1);
  assert.equal(get('SELECT status FROM entries WHERE id = ?', entry.id).status, 'active');

  // Round 2 gets the next one along, not the same club again.
  const second = all('SELECT * FROM gameweeks WHERE season_id = ? AND number = 2', past.seasonId);
  assert.ok(second.length);
  applyAutoPicks();
  const round2 = get(
    `SELECT t.name FROM picks p JOIN teams t ON t.id = p.team_id
     WHERE p.entry_id = ? AND p.round_number = 2`,
    entry.id,
  );
  assert.ok(round2 && round2.name !== alphabeticallyFirst);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
