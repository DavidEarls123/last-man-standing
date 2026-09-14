import express from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { all, get, run, audit, getSetting, setSetting, transaction } from '../db/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parse, wrap, emailSchema, phoneSchema } from '../lib/validate.js';
import { hashPassword, randomCode } from '../lib/auth.js';
import { nowIso } from '../lib/time.js';
import { requireSuperAdmin } from '../middleware/auth.js';
import { createLeague, leagueContext, leagueOverview } from '../services/leagues.js';
import { isValidOpeningPicks } from '../domain/rules.js';
import { availableTeamsForRound, entryPicks, submitPick } from '../services/picks.js';
import { recomputeLeague, settleRound, settleAllLeagues } from '../services/settlement.js';
import { NOTIFICATION_DEFAULTS, dispatchDueNotifications, notificationSettings, queueDeadlineReminders } from '../services/notifications.js';
import { seedSeason } from '../db/seed.js';
import { createLocalProvider } from '../services/football/local.js';
import { broadcastLive } from '../services/live.js';
import { verifyAllLeagues } from '../services/verification.js';
import { publicUser } from './auth.js';

export const adminRouter = express.Router();
adminRouter.use(requireSuperAdmin);

adminRouter.get('/overview', wrap(async (req, res) => {
  const counts = {
    users: get('SELECT COUNT(*) AS count FROM users').count,
    leagues: get('SELECT COUNT(*) AS count FROM leagues').count,
    activeLeagues: get("SELECT COUNT(*) AS count FROM leagues WHERE status IN ('open','active')").count,
    entries: get('SELECT COUNT(*) AS count FROM entries').count,
    queuedNotifications: get("SELECT COUNT(*) AS count FROM notifications WHERE status = 'queued'").count,
    failedNotifications: get("SELECT COUNT(*) AS count FROM notifications WHERE status = 'failed'").count,
  };
  const leagues = all('SELECT * FROM leagues ORDER BY created_at DESC').map((league) => {
    const context = leagueContext(league);
    const overview = leagueOverview(league);
    const admin = league.admin_user_id ? get('SELECT display_name, email FROM users WHERE id = ?', league.admin_user_id) : null;
    return {
      id: league.id,
      name: league.name,
      status: league.status,
      joinCode: league.join_code,
      startGameweek: league.start_gameweek,
      admin: admin ? { name: admin.display_name, email: admin.email } : null,
      entries: overview.totalEntries,
      active: overview.active,
      nextOpenRound: context.nextOpenRound,
      entryClosed: context.entryClosed,
      configLocked: context.configLocked,
      smsEnabled: Boolean(league.sms_enabled),
    };
  });
  res.json({ counts, leagues, settings: notificationSettings() });
}));

// ------------------------------------------------------------------- users --

adminRouter.get('/users', wrap(async (req, res) => {
  const search = String(req.query.q || '').trim().toLowerCase();
  const rows = search
    ? all(
        `SELECT * FROM users WHERE lower(display_name) LIKE ? OR lower(email) LIKE ? OR phone LIKE ?
         ORDER BY created_at DESC LIMIT 200`,
        `%${search}%`, `%${search}%`, `%${search}%`,
      )
    : all('SELECT * FROM users ORDER BY created_at DESC LIMIT 200');
  res.json({
    users: rows.map((user) => ({
      ...publicUser(user),
      status: user.status,
      leagues: get('SELECT COUNT(*) AS count FROM entries WHERE user_id = ?', user.id).count,
      adminOf: all('SELECT id, name FROM leagues WHERE admin_user_id = ?', user.id),
    })),
  });
}));

const createUserSchema = z
  .object({
    displayName: z.string().trim().min(2).max(60),
    email: emailSchema.optional().or(z.literal('').transform(() => undefined)),
    phone: phoneSchema.optional().or(z.literal('').transform(() => undefined)),
    password: z.string().min(10).optional(),
  })
  .refine((value) => value.email || value.phone, { message: 'Give an email address or a mobile number', path: ['email'] });

adminRouter.post('/users', wrap(async (req, res) => {
  const body = parse(createUserSchema, req.body);
  if (body.email && get('SELECT 1 FROM users WHERE email = ?', body.email)) throw conflict('Email already registered');
  if (body.phone && get('SELECT 1 FROM users WHERE phone = ?', body.phone)) throw conflict('Phone already registered');
  const password = body.password ?? `${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`;
  const result = run(
    `INSERT INTO users (email, phone, display_name, password_hash, notify_email, notify_sms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    body.email ?? null, body.phone ?? null, body.displayName, await hashPassword(password),
    body.email ? 1 : 0, body.phone ? 1 : 0, nowIso(),
  );
  const user = get('SELECT * FROM users WHERE id = ?', Number(result.lastInsertRowid));
  audit(req.user.id, 'admin.user_created', 'user', user.id, null);
  res.status(201).json({ user: publicUser(user), temporaryPassword: body.password ? null : password });
}));

adminRouter.patch('/users/:userId', wrap(async (req, res) => {
  const user = get('SELECT * FROM users WHERE id = ?', Number(req.params.userId));
  if (!user) throw notFound('User not found');
  const body = parse(
    z.object({
      displayName: z.string().trim().min(2).max(60).optional(),
      email: emailSchema.nullable().optional(),
      phone: phoneSchema.nullable().optional(),
      status: z.enum(['active', 'suspended']).optional(),
      resetPassword: z.boolean().optional(),
      signOutEverywhere: z.boolean().optional(),
    }),
    req.body,
  );

  let temporaryPassword = null;
  if (body.resetPassword) {
    temporaryPassword = `${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`;
    run('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?',
      await hashPassword(temporaryPassword), user.id);
  }
  if (body.signOutEverywhere) run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', user.id);

  run(
    'UPDATE users SET display_name = ?, email = ?, phone = ?, status = ? WHERE id = ?',
    body.displayName ?? user.display_name,
    body.email === undefined ? user.email : body.email,
    body.phone === undefined ? user.phone : body.phone,
    body.status ?? user.status,
    user.id,
  );
  audit(req.user.id, 'admin.user_updated', 'user', user.id, { ...body, resetPassword: Boolean(body.resetPassword) });
  res.json({ user: publicUser(get('SELECT * FROM users WHERE id = ?', user.id)), temporaryPassword });
}));

// ----------------------------------------------------------------- leagues --

const leagueSchema = z.object({
  name: z.string().trim().min(2).max(80),
  seasonId: z.number().int().optional(),
  // Optional on create: the platform admin hands the league to someone, and
  // that admin sets the start gameweek and the rules themselves.
  startGameweek: z.number().int().min(1).max(38).optional(),
  adminUserId: z.number().int().nullable().optional(),
  adminEmail: emailSchema.optional(),
  openingPicks: z.number().int()
    .refine(isValidOpeningPicks, 'Choose no opening block (0), or between 2 and 10 rounds')
    .default(0),
  drawPolicy: z.enum(['eliminate', 'survive']).default('eliminate'),
  voidPolicy: z.enum(['reselect', 'eliminate', 'survive']).default('reselect'),
  noPickPolicy: z.enum(['auto_alphabetical', 'eliminate']).default('auto_alphabetical'),
  maxEntries: z.number().int().min(2).nullable().optional(),
  // Super admin only: texts cost money, so they are switchable per league.
  smsEnabled: z.boolean().optional(),
});

adminRouter.post('/leagues', wrap(async (req, res) => {
  const body = parse(leagueSchema, req.body);
  const season = body.seasonId
    ? get('SELECT * FROM seasons WHERE id = ?', body.seasonId)
    : get('SELECT * FROM seasons WHERE is_current = 1');
  if (!season) throw badRequest('No season available — seed a season first');

  let adminUserId = body.adminUserId ?? null;
  if (!adminUserId && body.adminEmail) {
    const existing = get('SELECT * FROM users WHERE email = ?', body.adminEmail);
    if (!existing) throw notFound(`No user with email ${body.adminEmail} — create the account first`);
    adminUserId = existing.id;
  }

  // Start at the next gameweek that has not kicked off; the league admin moves
  // it wherever they want before anyone picks.
  const startGameweek = body.startGameweek ?? (
    get(
      'SELECT number FROM gameweeks WHERE season_id = ? AND deadline > ? ORDER BY number LIMIT 1',
      season.id, nowIso(),
    )?.number
    ?? get('SELECT MIN(number) AS number FROM gameweeks WHERE season_id = ?', season.id)?.number
    ?? 1
  );

  const league = createLeague({
    name: body.name,
    seasonId: season.id,
    startGameweek,
    adminUserId,
    createdBy: req.user.id,
    openingPicks: body.openingPicks,
    drawPolicy: body.drawPolicy,
    voidPolicy: body.voidPolicy,
    noPickPolicy: body.noPickPolicy,
    maxEntries: body.maxEntries ?? null,
  });
  res.status(201).json({ league });
}));

adminRouter.patch('/leagues/:leagueId', wrap(async (req, res) => {
  const league = get('SELECT * FROM leagues WHERE id = ?', Number(req.params.leagueId));
  if (!league) throw notFound('League not found');
  const body = parse(
    leagueSchema.partial().extend({ status: z.enum(['open', 'active', 'completed', 'archived']).optional() }),
    req.body,
  );

  let adminUserId = body.adminUserId === undefined ? league.admin_user_id : body.adminUserId;
  if (body.adminEmail) {
    const admin = get('SELECT * FROM users WHERE email = ?', body.adminEmail);
    if (!admin) throw notFound(`No user with email ${body.adminEmail}`);
    adminUserId = admin.id;
  }
  if (body.startGameweek && body.startGameweek !== league.start_gameweek) {
    const played = get('SELECT COUNT(*) AS count FROM picks WHERE league_id = ?', league.id).count;
    if (played > 0) throw conflict('Picks have already been made — moving the start gameweek would invalidate them');
  }

  run(
    `UPDATE leagues SET name = ?, start_gameweek = ?, admin_user_id = ?, opening_picks = ?,
            draw_policy = ?, void_policy = ?, no_pick_policy = ?, max_entries = ?, sms_enabled = ?, status = ?
     WHERE id = ?`,
    body.name ?? league.name,
    body.startGameweek ?? league.start_gameweek,
    adminUserId,
    body.openingPicks ?? league.opening_picks,
    body.drawPolicy ?? league.draw_policy,
    body.voidPolicy ?? league.void_policy,
    body.noPickPolicy ?? league.no_pick_policy,
    body.maxEntries === undefined ? league.max_entries : body.maxEntries,
    body.smsEnabled === undefined ? league.sms_enabled : Number(body.smsEnabled),
    body.status ?? league.status,
    league.id,
  );
  audit(req.user.id, 'admin.league_updated', 'league', league.id, {
    ...body, supersededLock: Boolean(league.config_locked_at),
  });
  res.json({ league: get('SELECT * FROM leagues WHERE id = ?', league.id) });
}));

adminRouter.delete('/leagues/:leagueId', wrap(async (req, res) => {
  const league = get('SELECT * FROM leagues WHERE id = ?', Number(req.params.leagueId));
  if (!league) throw notFound('League not found');
  const hard = req.query.hard === 'true';
  if (hard) {
    run('DELETE FROM leagues WHERE id = ?', league.id);
  } else {
    run("UPDATE leagues SET status = 'archived' WHERE id = ?", league.id);
  }
  audit(req.user.id, hard ? 'admin.league_deleted' : 'admin.league_archived', 'league', league.id, null);
  res.json({ ok: true });
}));

adminRouter.post('/leagues/:leagueId/recompute', wrap(async (req, res) => {
  const results = recomputeLeague(Number(req.params.leagueId), { actorUserId: req.user.id });
  broadcastLive();
  res.json({ ok: true, rounds: results });
}));

adminRouter.post('/leagues/:leagueId/settle', wrap(async (req, res) => {
  const body = parse(z.object({ round: z.number().int().min(1), force: z.boolean().default(false) }), req.body);
  const result = settleRound(Number(req.params.leagueId), body.round, { actorUserId: req.user.id, force: body.force });
  broadcastLive();
  res.json(result);
}));

/** Every entry in a league with its picks — the override screen's data. */
adminRouter.get('/leagues/:leagueId/entries', wrap(async (req, res) => {
  const league = get('SELECT * FROM leagues WHERE id = ?', Number(req.params.leagueId));
  if (!league) throw notFound('League not found');
  const context = leagueContext(league);
  const entries = all(
    `SELECT e.*, u.display_name FROM entries e JOIN users u ON u.id = e.user_id
     WHERE e.league_id = ? ORDER BY u.display_name COLLATE NOCASE`,
    league.id,
  );
  res.json({
    rounds: context.rounds.slice(0, 40).map((round) => ({
      round: round.round, gameweek: round.gameweek.number, deadlinePassed: round.deadlinePassed, settled: round.settled,
    })),
    entries: entries.map((entry) => ({
      entryId: entry.id,
      name: entry.display_name,
      status: entry.status,
      eliminatedRound: entry.eliminated_round,
      isWinner: Boolean(entry.is_winner),
      picks: entryPicks(entry.id).map((pick) => ({
        round: pick.round_number, team: pick.team_name, outcome: pick.outcome, result: pick.result,
      })),
    })),
  });
}));

adminRouter.get('/leagues/:leagueId/entries/:entryId/teams', wrap(async (req, res) => {
  const league = get('SELECT * FROM leagues WHERE id = ?', Number(req.params.leagueId));
  if (!league) throw notFound('League not found');
  const entry = get('SELECT * FROM entries WHERE id = ? AND league_id = ?', Number(req.params.entryId), league.id);
  if (!entry) throw notFound('Entry not found');
  const round = Number(req.query.round);
  if (!Number.isInteger(round) || round < 1) throw badRequest('round must be a positive whole number');
  res.json({ round, teams: availableTeamsForRound(league, entry, round) });
}));

/** Override a pick — for the "my dog ate my deadline" phone calls. */
adminRouter.post('/leagues/:leagueId/entries/:entryId/pick', wrap(async (req, res) => {
  const league = get('SELECT * FROM leagues WHERE id = ?', Number(req.params.leagueId));
  if (!league) throw notFound('League not found');
  const entry = get('SELECT * FROM entries WHERE id = ? AND league_id = ?', Number(req.params.entryId), league.id);
  if (!entry) throw notFound('Entry not found');
  const body = parse(z.object({ round: z.number().int().min(1), teamId: z.number().int() }), req.body);
  const pick = submitPick({
    league, entry, round: body.round, teamId: body.teamId, actorUserId: req.user.id, override: true,
  });
  res.json({ pick });
}));

adminRouter.patch('/entries/:entryId', wrap(async (req, res) => {
  const entry = get('SELECT * FROM entries WHERE id = ?', Number(req.params.entryId));
  if (!entry) throw notFound('Entry not found');
  const body = parse(
    z.object({
      status: z.enum(['active', 'eliminated', 'withdrawn']).optional(),
      eliminatedRound: z.number().int().nullable().optional(),
      isWinner: z.boolean().optional(),
    }),
    req.body,
  );
  run(
    `UPDATE entries SET status = ?, eliminated_round = ?, eliminated_reason = ?, eliminated_at = ?, is_winner = ?
     WHERE id = ?`,
    body.status ?? entry.status,
    body.eliminatedRound === undefined ? entry.eliminated_round : body.eliminatedRound,
    body.status === 'active' ? null : entry.eliminated_reason ?? 'admin',
    body.status === 'active' ? null : entry.eliminated_at ?? nowIso(),
    body.isWinner === undefined ? entry.is_winner : Number(body.isWinner),
    entry.id,
  );
  audit(req.user.id, 'admin.entry_updated', 'entry', entry.id, body);
  res.json({ entry: get('SELECT * FROM entries WHERE id = ?', entry.id) });
}));

// -------------------------------------------------------- seasons/fixtures --

adminRouter.get('/seasons', wrap(async (req, res) => {
  res.json({
    seasons: all('SELECT * FROM seasons ORDER BY name DESC').map((season) => ({
      ...season,
      teams: get('SELECT COUNT(*) AS count FROM teams WHERE season_id = ?', season.id).count,
      gameweeks: get('SELECT COUNT(*) AS count FROM gameweeks WHERE season_id = ?', season.id).count,
    })),
  });
}));

adminRouter.post('/seasons/seed', wrap(async (req, res) => {
  const body = parse(
    z.object({
      seasonName: z.string().trim().min(4).optional(),
      startDate: z.string().datetime().optional(),
      reset: z.boolean().default(false),
      backfillResults: z.boolean().default(false),
    }),
    req.body,
  );
  const result = seedSeason({
    seasonName: body.seasonName,
    startDate: body.startDate ? new Date(body.startDate) : undefined,
    reset: body.reset,
  });
  if (body.backfillResults) {
    result.backfilled = createLocalProvider().backfillFinished();
    settleAllLeagues({ actorUserId: req.user.id });
  }
  audit(req.user.id, 'admin.season_seeded', 'season', result.seasonId, result);
  res.json(result);
}));

adminRouter.get('/seasons/:seasonId/gameweeks', wrap(async (req, res) => {
  const seasonId = Number(req.params.seasonId);
  res.json({
    gameweeks: all('SELECT * FROM gameweeks WHERE season_id = ? ORDER BY number', seasonId).map((gameweek) => ({
      ...gameweek,
      fixtures: all(
        `SELECT f.*, h.name AS home_name, a.name AS away_name
         FROM fixtures f JOIN teams h ON h.id = f.home_team_id JOIN teams a ON a.id = f.away_team_id
         WHERE f.gameweek_id = ? ORDER BY f.kickoff`,
        gameweek.id,
      ),
    })),
  });
}));

adminRouter.patch('/fixtures/:fixtureId', wrap(async (req, res) => {
  const fixture = get('SELECT * FROM fixtures WHERE id = ?', Number(req.params.fixtureId));
  if (!fixture) throw notFound('Fixture not found');
  const body = parse(
    z.object({
      homeScore: z.number().int().min(0).nullable().optional(),
      awayScore: z.number().int().min(0).nullable().optional(),
      status: z.enum(['scheduled', 'live', 'finished', 'postponed', 'abandoned']).optional(),
      minute: z.number().int().min(0).max(130).nullable().optional(),
      kickoff: z.string().datetime().optional(),
    }),
    req.body,
  );
  run(
    'UPDATE fixtures SET home_score = ?, away_score = ?, status = ?, minute = ?, kickoff = ?, updated_at = ? WHERE id = ?',
    body.homeScore === undefined ? fixture.home_score : body.homeScore,
    body.awayScore === undefined ? fixture.away_score : body.awayScore,
    body.status ?? fixture.status,
    body.minute === undefined ? fixture.minute : body.minute,
    body.kickoff ?? fixture.kickoff,
    nowIso(), fixture.id,
  );
  if (body.kickoff) {
    run(
      `UPDATE gameweeks SET deadline = (SELECT MIN(kickoff) FROM fixtures WHERE gameweek_id = ?) WHERE id = ?`,
      fixture.gameweek_id, fixture.gameweek_id,
    );
  }
  audit(req.user.id, 'admin.fixture_updated', 'fixture', fixture.id, body);
  const settled = settleAllLeagues({ actorUserId: req.user.id });
  broadcastLive();
  res.json({ fixture: get('SELECT * FROM fixtures WHERE id = ?', fixture.id), settled });
}));

// ---------------------------------------------------------------- settings --

adminRouter.get('/settings', wrap(async (req, res) => {
  res.json({ notifications: notificationSettings(), defaults: NOTIFICATION_DEFAULTS });
}));

adminRouter.put('/settings/notifications', wrap(async (req, res) => {
  const body = parse(
    z.object({
      enabled: z.boolean().optional(),
      reminderOffsetsMinutes: z.array(z.number().int().min(5).max(20160)).max(6).optional(),
      finalCallOffsetMinutes: z.number().int().min(5).max(1440).nullable().optional(),
      resultNotices: z.boolean().optional(),
      channels: z.object({ email: z.boolean().optional(), sms: z.boolean().optional() }).optional(),
    }),
    req.body,
  );
  const current = notificationSettings();
  const next = {
    ...current,
    ...body,
    reminderOffsetsMinutes: (body.reminderOffsetsMinutes ?? current.reminderOffsetsMinutes)
      .slice().sort((a, b) => b - a),
    channels: { ...current.channels, ...(body.channels || {}) },
  };
  setSetting('notifications', next);
  audit(req.user.id, 'admin.settings_updated', 'settings', null, next);
  res.json({ notifications: next });
}));

adminRouter.post('/notifications/run', wrap(async (req, res) => {
  const queued = queueDeadlineReminders();
  const sent = await dispatchDueNotifications({ limit: 200 });
  res.json({ queued, sent });
}));

/**
 * The outbox, grouped. One deadline reminder to sixteen people is one line of
 * news, not sixteen; the individual messages are still there behind it.
 */
adminRouter.get('/notifications', wrap(async (req, res) => {
  const rows = all(
    `SELECT n.*, u.display_name, l.name AS league_name
     FROM notifications n
     JOIN users u ON u.id = n.user_id
     LEFT JOIN leagues l ON l.id = n.league_id
     ORDER BY n.created_at DESC LIMIT 500`,
  );

  // A batch is one kind of message, about one league and round, sent in one go.
  const roundOf = (row) => {
    if (!row.meta) return null;
    try { return JSON.parse(row.meta).round ?? null; } catch { return null; }
  };

  const batches = new Map();
  for (const row of rows) {
    const round = roundOf(row);
    const key = [row.kind, row.league_id ?? '-', round ?? '-', row.scheduled_for].join('|');
    if (!batches.has(key)) {
      batches.set(key, {
        key,
        kind: row.kind,
        leagueId: row.league_id ?? null,
        leagueName: row.league_name ?? null,
        round,
        scheduledFor: row.scheduled_for,
        subject: row.subject,
        counts: { total: 0, queued: 0, sent: 0, failed: 0, email: 0, sms: 0 },
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

  res.json({ batches: [...batches.values()].slice(0, 60) });
}));

// ------------------------------------------------------- recovery + audit ---

adminRouter.post('/recovery-codes', wrap(async (req, res) => {
  const codes = Array.from({ length: 10 }, () => `${randomCode(5)}-${randomCode(5)}`);
  await transactionAsyncSafe(req.user.id, codes);
  audit(req.user.id, 'admin.recovery_codes_regenerated', 'user', req.user.id, { count: codes.length });
  res.json({
    codes,
    message: 'Store these somewhere safe and offline. They are shown once and each works a single time.',
  });
}));

async function transactionAsyncSafe(userId, codes) {
  const hashes = await Promise.all(codes.map((code) => bcrypt.hash(code.replace(/-/g, ''), 12)));
  transaction(() => {
    run('DELETE FROM recovery_codes WHERE user_id = ?', userId);
    for (const hash of hashes) {
      run('INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)', userId, hash, nowIso());
    }
  });
}

/** Cross-check every league on the platform in one sweep. */
adminRouter.get('/verification', wrap(async (req, res) => {
  const reports = verifyAllLeagues();
  res.json({
    checkedAt: nowIso(),
    leagues: reports.map((report) => ({
      leagueId: report.leagueId,
      leagueName: report.leagueName,
      ok: report.ok,
      errors: report.errorCount,
      warnings: report.warningCount,
      picksChecked: report.picksChecked,
      entriesChecked: report.entriesChecked,
      roundsSettled: report.roundsSettled,
      issues: report.issues.slice(0, 25),
    })),
    failing: reports.filter((report) => !report.ok).length,
  });
}));

adminRouter.get('/audit', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({
    entries: all(
      `SELECT a.*, u.display_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
       ORDER BY a.id DESC LIMIT ?`,
      limit,
    ),
  });
}));

adminRouter.get('/health', wrap(async (req, res) => {
  res.json({
    ok: true,
    database: getSetting('__probe', null) === null,
    time: nowIso(),
  });
}));

