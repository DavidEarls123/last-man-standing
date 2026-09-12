import express from 'express';
import { z } from 'zod';
import { all, get, run, audit } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { parse, wrap, emailSchema, phoneSchema } from '../lib/validate.js';
import { hashPassword, randomCode } from '../lib/auth.js';
import { nowIso } from '../lib/time.js';
import { config } from '../config.js';
import {
  loadLeague, requireAuth, requireLeagueAdmin, requireLeagueMember,
} from '../middleware/auth.js';
import {
  generateJoinCode, getEntry, getLeagueByCode, joinLeague, leagueContext,
  leagueOverview, leagueStandings,
} from '../services/leagues.js';
import { availableTeamsForRound, entryPicks, pickPopularity, roundFixturesWithPicks, submitPick } from '../services/picks.js';
import { addClient } from '../services/live.js';
import { queueDirect } from '../services/notifications.js';

export const leaguesRouter = express.Router();

const summarise = (league, context, entry, role) => ({
  id: league.id,
  name: league.name,
  joinCode: role === 'admin' || role === 'super_admin' ? league.join_code : undefined,
  status: league.status,
  startGameweek: league.start_gameweek,
  initialPicks: league.initial_picks,
  drawPolicy: league.draw_policy,
  voidPolicy: league.void_policy,
  noPickPolicy: league.no_pick_policy,
  entryDeadline: context.entryDeadline,
  entryClosed: context.entryClosed,
  nextOpenRound: context.nextOpenRound,
  roundInPlay: context.roundInPlay,
  lastSettledRound: context.lastSettledRound,
  focusRound: context.focusRound,
  teamCount: context.teamCount,
  role,
  entry: entry
    ? {
        id: entry.id,
        status: entry.status,
        eliminatedRound: entry.eliminated_round,
        eliminatedReason: entry.eliminated_reason,
        isWinner: Boolean(entry.is_winner),
      }
    : null,
});

leaguesRouter.get('/', requireAuth, wrap(async (req, res) => {
  const rows = req.user.is_super_admin
    ? all('SELECT * FROM leagues ORDER BY created_at DESC')
    : all(
        `SELECT DISTINCT l.* FROM leagues l
         LEFT JOIN entries e ON e.league_id = l.id AND e.user_id = ?
         WHERE e.id IS NOT NULL OR l.admin_user_id = ?
         ORDER BY l.created_at DESC`,
        req.user.id, req.user.id,
      );

  res.json({
    leagues: rows.map((league) => {
      const context = leagueContext(league);
      const entry = getEntry(league.id, req.user.id);
      const role = req.user.is_super_admin
        ? 'super_admin'
        : league.admin_user_id === req.user.id ? 'admin' : entry ? 'player' : 'guest';
      const overview = leagueOverview(league);
      return { ...summarise(league, context, entry, role), totalEntries: overview.totalEntries, active: overview.active };
    }),
  });
}));

leaguesRouter.post('/join', requireAuth, wrap(async (req, res) => {
  const body = parse(z.object({ code: z.string().trim().min(4).max(12) }), req.body);
  const league = getLeagueByCode(body.code);
  if (!league) throw notFound('No league found for that code');
  const entry = joinLeague(league, req.user.id);
  const context = leagueContext(league);
  res.status(201).json({ league: summarise(league, context, entry, 'player') });
}));

/** Public-ish preview so an invite link can show what you are joining. */
leaguesRouter.get('/preview/:code', wrap(async (req, res) => {
  const league = getLeagueByCode(req.params.code);
  if (!league) throw notFound('No league found for that code');
  const context = leagueContext(league);
  const overview = leagueOverview(league);
  res.json({
    name: league.name,
    startGameweek: league.start_gameweek,
    entryDeadline: context.entryDeadline,
    entryClosed: context.entryClosed,
    totalEntries: overview.totalEntries,
    initialPicks: league.initial_picks,
  });
}));

leaguesRouter.use('/:leagueId', requireAuth, loadLeague);

leaguesRouter.get('/:leagueId', requireLeagueMember, wrap(async (req, res) => {
  const context = leagueContext(req.league);
  res.json({
    league: summarise(req.league, context, req.entry, req.leagueRole),
    overview: leagueOverview(req.league),
    rounds: context.rounds.map((round) => ({
      round: round.round,
      gameweek: round.gameweek.number,
      deadline: round.deadline,
      deadlinePassed: round.deadlinePassed,
      settled: round.settled,
      inPlay: round.inPlay,
    })),
  });
}));

/** Everything the home tab needs in one call. */
leaguesRouter.get('/:leagueId/home', requireLeagueMember, wrap(async (req, res) => {
  const context = leagueContext(req.league);
  const picks = req.entry ? entryPicks(req.entry.id) : [];
  const nextRound = context.nextOpenRound;
  const needsPick = Boolean(
    req.entry && req.entry.status === 'active' && nextRound
      && !picks.some((pick) => pick.round_number === nextRound),
  );
  const outstandingInitial = req.entry && !context.entryClosed
    ? Array.from({ length: req.league.initial_picks }, (_, index) => index + 1)
        .filter((round) => !picks.some((pick) => pick.round_number === round))
    : [];

  res.json({
    league: summarise(req.league, context, req.entry, req.leagueRole),
    overview: leagueOverview(req.league),
    picks: picks.map((pick) => ({
      round: pick.round_number,
      gameweek: pick.gameweek,
      cycle: pick.cycle,
      team: pick.team_name,
      teamShort: pick.team_short,
      teamId: pick.team_id,
      outcome: pick.outcome,
      result: pick.result,
      deadline: pick.deadline,
    })),
    nextDeadline: nextRound ? context.roundInfo(nextRound).deadline : null,
    nextRound,
    needsPick,
    outstandingInitialRounds: outstandingInitial,
    standings: leagueStandings(req.league).map((row) => ({
      entryId: row.entry_id,
      name: row.display_name,
      status: row.status,
      eliminatedRound: row.eliminated_round,
      eliminatedReason: row.eliminated_reason,
      isWinner: Boolean(row.is_winner),
      roundsSurvived: row.rounds_survived,
      isMe: row.user_id === req.user.id,
    })),
  });
}));

const roundParam = (req) => {
  const round = Number(req.params.round);
  if (!Number.isInteger(round) || round < 1) throw badRequest('Round must be a positive whole number');
  return round;
};

leaguesRouter.get('/:leagueId/rounds/:round/teams', requireLeagueMember, wrap(async (req, res) => {
  if (!req.entry) throw forbidden('Only entrants pick teams');
  res.json({ round: roundParam(req), teams: availableTeamsForRound(req.league, req.entry, roundParam(req)) });
}));

leaguesRouter.post('/:leagueId/picks', requireLeagueMember, wrap(async (req, res) => {
  if (!req.entry) throw forbidden('Only entrants pick teams');
  const body = parse(z.object({ round: z.number().int().min(1), teamId: z.number().int() }), req.body);
  const pick = submitPick({
    league: req.league, entry: req.entry, round: body.round, teamId: body.teamId, actorUserId: req.user.id,
  });
  res.status(201).json({ pick: { round: pick.round_number, teamId: pick.team_id, result: pick.result } });
}));

leaguesRouter.get('/:leagueId/rounds/:round/popularity', requireLeagueMember, wrap(async (req, res) => {
  res.json(pickPopularity(req.league, roundParam(req)));
}));

leaguesRouter.get('/:leagueId/rounds/:round/fixtures', requireLeagueMember, wrap(async (req, res) => {
  res.json(roundFixturesWithPicks(req.league, roundParam(req)));
}));

/** Who picked what. Hidden until the round locks, so nobody copies the field. */
leaguesRouter.get('/:leagueId/rounds/:round/picks', requireLeagueMember, wrap(async (req, res) => {
  const round = roundParam(req);
  const context = leagueContext(req.league);
  const roundInfo = context.roundInfo(round);
  const isAdmin = req.leagueRole === 'admin' || req.leagueRole === 'super_admin';
  if (!roundInfo) throw notFound('No such round');
  if (!roundInfo.deadlinePassed && !isAdmin) {
    return res.json({ round, revealed: false, picks: [] });
  }
  const picks = all(
    `SELECT p.round_number, p.outcome, p.result, t.name AS team, u.display_name, e.id AS entry_id
     FROM picks p
     JOIN entries e ON e.id = p.entry_id
     JOIN users u ON u.id = e.user_id
     JOIN teams t ON t.id = p.team_id
     WHERE p.league_id = ? AND p.round_number = ?
     ORDER BY u.display_name COLLATE NOCASE`,
    req.league.id, round,
  );
  res.json({
    round,
    revealed: true,
    picks: picks.map((pick) => ({
      entryId: pick.entry_id, name: pick.display_name, team: pick.team,
      outcome: pick.outcome, result: pick.result,
    })),
  });
}));

/** Server-Sent Events: live scores plus pick counts for the round on screen. */
leaguesRouter.get('/:leagueId/live', requireLeagueMember, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const round = req.query.round ? Number(req.query.round) : null;
  addClient(res, { leagueId: req.league.id, round: Number.isInteger(round) ? round : null });
});

// ------------------------------------------------------- league admin tools --

leaguesRouter.get('/:leagueId/members', requireLeagueAdmin, wrap(async (req, res) => {
  const members = all(
    `SELECT e.id AS entry_id, e.status, e.eliminated_round, e.joined_at,
            u.id AS user_id, u.display_name, u.email, u.phone
     FROM entries e JOIN users u ON u.id = e.user_id
     WHERE e.league_id = ? ORDER BY u.display_name COLLATE NOCASE`,
    req.league.id,
  );
  res.json({
    joinCode: req.league.join_code,
    joinUrl: `${config.publicUrl}/join/${req.league.join_code}`,
    members: members.map((member) => ({
      entryId: member.entry_id,
      userId: member.user_id,
      name: member.display_name,
      email: member.email,
      phone: member.phone,
      status: member.status,
      eliminatedRound: member.eliminated_round,
      joinedAt: member.joined_at,
    })),
  });
}));

const addMemberSchema = z
  .object({
    displayName: z.string().trim().min(2).max(60),
    email: emailSchema.optional().or(z.literal('').transform(() => undefined)),
    phone: phoneSchema.optional().or(z.literal('').transform(() => undefined)),
  })
  .refine((value) => value.email || value.phone, { message: 'Give an email address or a mobile number', path: ['email'] });

/** Add a player directly. Creates the account if they do not have one yet. */
leaguesRouter.post('/:leagueId/members', requireLeagueAdmin, wrap(async (req, res) => {
  const body = parse(addMemberSchema, req.body);
  let user = body.email
    ? get('SELECT * FROM users WHERE email = ?', body.email)
    : null;
  if (!user && body.phone) user = get('SELECT * FROM users WHERE phone = ?', body.phone);

  let temporaryPassword = null;
  if (!user) {
    temporaryPassword = `${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`;
    const result = run(
      `INSERT INTO users (email, phone, display_name, password_hash, notify_email, notify_sms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      body.email ?? null, body.phone ?? null, body.displayName,
      await hashPassword(temporaryPassword), body.email ? 1 : 0, body.phone ? 1 : 0, nowIso(),
    );
    user = get('SELECT * FROM users WHERE id = ?', Number(result.lastInsertRowid));
    queueDirect(user, {
      kind: 'account_created',
      league: req.league,
      subject: `You have been added to ${req.league.name}`,
      body: [
        `Hi ${user.display_name},`,
        '',
        `${req.user.display_name} has entered you into the Last Man Standing competition "${req.league.name}".`,
        '',
        `Sign in at ${config.publicUrl} with this temporary password: ${temporaryPassword}`,
        'Change it as soon as you are in, then make your picks.',
      ].join('\n'),
    });
  }

  const entry = joinLeague(req.league, user.id, { force: req.leagueRole === 'super_admin' });
  audit(req.user.id, 'league.member_added', 'league', req.league.id, { userId: user.id });
  res.status(201).json({
    entryId: entry.id,
    userId: user.id,
    name: user.display_name,
    temporaryPassword,
  });
}));

leaguesRouter.delete('/:leagueId/members/:entryId', requireLeagueAdmin, wrap(async (req, res) => {
  const entry = get('SELECT * FROM entries WHERE id = ? AND league_id = ?', Number(req.params.entryId), req.league.id);
  if (!entry) throw notFound('That player is not in this league');
  if (entry.user_id === req.league.admin_user_id && req.leagueRole !== 'super_admin') {
    throw forbidden('The league admin cannot remove their own entry — ask the super admin');
  }
  const context = leagueContext(req.league);
  if (context.entryClosed && req.leagueRole !== 'super_admin') {
    // Once the competition is under way, withdraw rather than delete so the
    // history of previous rounds stays intact.
    run("UPDATE entries SET status = 'withdrawn' WHERE id = ?", entry.id);
    audit(req.user.id, 'league.member_withdrawn', 'entry', entry.id, { leagueId: req.league.id });
    return res.json({ ok: true, action: 'withdrawn' });
  }
  run('DELETE FROM entries WHERE id = ?', entry.id);
  audit(req.user.id, 'league.member_removed', 'entry', entry.id, { leagueId: req.league.id });
  res.json({ ok: true, action: 'removed' });
}));

leaguesRouter.post('/:leagueId/join-code', requireLeagueAdmin, wrap(async (req, res) => {
  const code = generateJoinCode();
  run('UPDATE leagues SET join_code = ? WHERE id = ?', code, req.league.id);
  audit(req.user.id, 'league.join_code_rotated', 'league', req.league.id, null);
  res.json({ joinCode: code, joinUrl: `${config.publicUrl}/join/${code}` });
}));

leaguesRouter.patch('/:leagueId', requireLeagueAdmin, wrap(async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(2).max(80) }), req.body);
  run('UPDATE leagues SET name = ? WHERE id = ?', body.name, req.league.id);
  audit(req.user.id, 'league.rename', 'league', req.league.id, { name: body.name });
  res.json({ ok: true });
}));

/** League admins can message their players (e.g. a nudge before a deadline). */
leaguesRouter.post('/:leagueId/announce', requireLeagueAdmin, wrap(async (req, res) => {
  const body = parse(
    z.object({ subject: z.string().trim().min(3).max(120), message: z.string().trim().min(3).max(2000) }),
    req.body,
  );
  const users = all(
    `SELECT u.* FROM entries e JOIN users u ON u.id = e.user_id WHERE e.league_id = ?`,
    req.league.id,
  );
  let queued = 0;
  for (const user of users) {
    queued += queueDirect(user, {
      kind: 'announcement',
      league: req.league,
      subject: `${req.league.name}: ${body.subject}`,
      body: `${body.message}\n\n— ${req.user.display_name}`,
      dedupeKey: `announce:${req.league.id}:${user.id}:${Date.now()}`,
    });
  }
  audit(req.user.id, 'league.announce', 'league', req.league.id, { recipients: users.length });
  res.json({ ok: true, queued });
}));

