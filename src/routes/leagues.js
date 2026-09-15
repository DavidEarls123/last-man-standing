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
import {
  availableTeamsForRound, entryPicks, pickIsLocked, pickPopularity, roundFixturesWithPicks, submitPick,
} from '../services/picks.js';
import {
  OPENING_PICKS_MAX, OPENING_PICKS_MIN, isValidOpeningPicks, openPickRounds, outstandingOpeningRounds,
} from '../domain/rules.js';
import { LEAGUE_ICONS, isLeagueIcon } from '../domain/leagueIcons.js';
import { addClient } from '../services/live.js';
import { verifyLeague } from '../services/verification.js';
import { queueDirect } from '../services/notifications.js';
import { leagueOutbox } from '../services/outbox.js';
import {
  changeRequestsFor, requestChange, resolveOpenRequestsFor,
} from '../services/changeRequests.js';

export const leaguesRouter = express.Router();

/** Anonymity hides entrants from each other, never from the people running it. */
const namesHidden = (league, role) =>
  Boolean(league.anonymous_entrants) && role !== 'admin' && role !== 'super_admin';

const summarise = (league, context, entry, role) => ({
  id: league.id,
  name: league.name,
  tagline: league.tagline,
  primaryColor: league.primary_color,
  secondaryColor: league.secondary_color,
  logoUrl: league.logo_mime ? `/api/leagues/${league.id}/logo` : null,
  logoPreset: league.logo_preset,
  // The invite code is issued at launch, not while the league is a draft.
  joinCode: (role === 'admin' || role === 'super_admin') && league.launched_at
    ? league.join_code : undefined,
  launched: Boolean(league.launched_at),
  launchedAt: league.launched_at,
  status: league.status,
  startGameweek: league.start_gameweek,
  openingPicks: league.opening_picks,
  drawPolicy: league.draw_policy,
  voidPolicy: league.void_policy,
  noPickPolicy: league.no_pick_policy,
  entryDeadline: context.entryDeadline,
  entryClosed: context.entryClosed,
  configLocked: context.configLocked,
  smsEnabled: Boolean(league.sms_enabled),
  anonymousEntrants: Boolean(league.anonymous_entrants),
  configLockedAt: context.configLockedAt,
  configLockReason: context.configLockReason,
  nextOpenRound: context.nextOpenRound,
  nextDeadline: context.nextOpenRound ? context.roundInfo(context.nextOpenRound).deadline : null,
  roundInPlay: context.roundInPlay,
  lastSettledRound: context.lastSettledRound,
  focusRound: context.focusRound,
  // The full span of rounds, so the round picker can show the whole season.
  lastRound: context.rounds[context.rounds.length - 1]?.round ?? 1,
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
    id: league.id,
    name: league.name,
    tagline: league.tagline,
    primaryColor: league.primary_color,
    secondaryColor: league.secondary_color,
    logoUrl: league.logo_mime ? `/api/leagues/${league.id}/logo` : null,
  logoPreset: league.logo_preset,
    startGameweek: league.start_gameweek,
    entryDeadline: context.entryDeadline,
    entryClosed: context.entryClosed,
    totalEntries: overview.totalEntries,
    openingPicks: league.opening_picks,
  });
}));

/** The ready-made crests an admin can choose instead of uploading one. */
leaguesRouter.get('/icons', (req, res) => res.json({ icons: LEAGUE_ICONS }));

/** League crest. Public so invite links and sign-in screens can show it. */
leaguesRouter.get('/:leagueId/logo', wrap(async (req, res) => {
  const league = get('SELECT logo_data, logo_mime FROM leagues WHERE id = ?', Number(req.params.leagueId));
  if (!league?.logo_data) throw notFound('This league has no crest');
  res.set('Content-Type', league.logo_mime);
  res.set('Cache-Control', 'public, max-age=300');
  // An uploaded file should never be able to run as a document on our origin.
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(Buffer.from(league.logo_data));
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
  const hideNames = namesHidden(req.league, req.leagueRole);
  const nextRound = context.nextOpenRound;
  const needsPick = Boolean(
    req.entry && req.entry.status === 'active' && nextRound
      && !picks.some((pick) => pick.round_number === nextRound),
  );
  // Rounds an entrant may pick for now: the one coming up, plus any the league
  // lets them get ahead on.
  // Everything still to come is pickable; only the opening block is compulsory.
  const lastRound = context.rounds[context.rounds.length - 1]?.round ?? 0;
  const openRounds = req.entry
    ? openPickRounds(nextRound, lastRound).filter((round) => {
        const info = context.roundInfo(round);
        return info && !info.deadlinePassed;
      })
    : [];
  // Before kick off the opening block is an obligation, not an option.
  const owedOpeningRounds = req.entry && !context.entryClosed
    ? outstandingOpeningRounds(picks, req.league.opening_picks)
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
      needsReselect: Boolean(pick.needs_reselect),
      reselectDeadline: pick.reselect_deadline,
      autoAssigned: Boolean(pick.auto_assigned),
      locked: pickIsLocked(pick, req.league.opening_picks),
    })),
    reselection: picks
      .filter((pick) => pick.needs_reselect)
      .map((pick) => ({ round: pick.round_number, team: pick.team_name, deadline: pick.reselect_deadline })),
    verification: (() => {
      const report = verifyLeague(req.league.id);
      return {
        ok: report.ok,
        errors: report.errorCount,
        warnings: report.warningCount,
        picksChecked: report.picksChecked,
        roundsSettled: report.roundsSettled,
        checkedAt: report.checkedAt,
      };
    })(),
    nextDeadline: nextRound ? context.roundInfo(nextRound).deadline : null,
    nextRound,
    needsPick,
    openRounds,
    owedOpeningRounds,
    unpickedOpenRounds: openRounds.filter((round) => !picks.some((pick) => pick.round_number === round)),
    // With anonymity on, only the admins see who is who. Everyone else gets the
    // shape of the field as a graph, and their own row.
    anonymised: hideNames,
    standings: leagueStandings(req.league).map((row) => ({
      entryId: row.entry_id,
      name: hideNames && row.user_id !== req.user.id ? null : row.display_name,
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
  const hideNames = namesHidden(req.league, req.leagueRole);
  res.json({
    round,
    revealed: true,
    anonymised: hideNames,
    picks: picks.map((pick) => ({
      entryId: pick.entry_id,
      name: hideNames ? null : pick.display_name,
      team: pick.team,
      outcome: pick.outcome,
      result: pick.result,
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

/**
 * The full cross-check: every pick recomputed from the fixture list and
 * compared with what was recorded. Detail is for the people who can act on it.
 */
leaguesRouter.get('/:leagueId/verification', requireLeagueAdmin, wrap(async (req, res) => {
  res.json(verifyLeague(req.league.id));
}));

/** Same check, run on demand and recorded in the audit trail. */
leaguesRouter.post('/:leagueId/verification', requireLeagueAdmin, wrap(async (req, res) => {
  const report = verifyLeague(req.league.id);
  audit(req.user.id, 'league.verification_run', 'league', req.league.id, {
    ok: report.ok, errors: report.errorCount,
  });
  res.json(report);
}));

// ------------------------------------------------------- league admin tools --

leaguesRouter.get('/:leagueId/members', requireLeagueAdmin, wrap(async (req, res) => {
  const members = all(
    `SELECT e.id AS entry_id, e.status, e.eliminated_round, e.eliminated_reason,
            e.reinstated_reason, e.joined_at,
            u.id AS user_id, u.display_name, u.email, u.phone
     FROM entries e JOIN users u ON u.id = e.user_id
     WHERE e.league_id = ? ORDER BY u.display_name COLLATE NOCASE`,
    req.league.id,
  );
  const launched = Boolean(req.league.launched_at);
  res.json({
    launched,
    joinCode: launched ? req.league.join_code : null,
    joinUrl: launched ? `${config.publicUrl}/join/${req.league.join_code}` : null,
    members: members.map((member) => ({
      entryId: member.entry_id,
      userId: member.user_id,
      name: member.display_name,
      email: member.email,
      phone: member.phone,
      status: member.status,
      eliminatedRound: member.eliminated_round,
      eliminatedReason: member.eliminated_reason,
      reinstatedReason: member.reinstated_reason,
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
        `${req.user.display_name} has entered you into the Last One Standing competition "${req.league.name}".`,
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

const hexColor = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #1f9d55');

const brandingSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  tagline: z.string().trim().max(120).nullable().optional(),
  primaryColor: hexColor.optional(),
  secondaryColor: hexColor.optional(),
  // 0 for no opening block, otherwise 2 to 10 — one would be no block at all.
  openingPicks: z.number().int()
    .refine(isValidOpeningPicks,
      `Choose no opening block, or between ${OPENING_PICKS_MIN} and ${OPENING_PICKS_MAX} rounds`)
    .optional(),
  // A data: URL from the crest upload, or null to clear it.
  logo: z.string().max(400_000).nullable().optional(),
  // Or one of the ready-made crests, by key.
  logoPreset: z.string().trim().max(40).nullable().optional()
    .refine((value) => value == null || isLeagueIcon(value), 'Unknown crest'),
  // The rules themselves belong to the league admin, not the platform admin.
  startGameweek: z.number().int().min(1).max(38).optional(),
  drawPolicy: z.enum(['eliminate', 'survive']).optional(),
  voidPolicy: z.enum(['reselect', 'eliminate', 'survive']).optional(),
  noPickPolicy: z.enum(['auto_alphabetical', 'eliminate']).optional(),
  anonymousEntrants: z.boolean().optional(),
});

// No SVG: it can carry script, and we serve crests from our own origin.
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_LOGO_BYTES = 256 * 1024;

function decodeLogo(dataUrl) {
  const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!match) throw badRequest('The crest must be an image file');
  const [, mime, base64] = match;
  if (!LOGO_TYPES.includes(mime)) throw badRequest('Use a PNG, JPEG, WebP or GIF crest');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw badRequest('That image could not be read');
  if (buffer.length > MAX_LOGO_BYTES) throw badRequest('Crests must be under 256KB');
  return { buffer, mime };
}

/** League admin: title, colours, crest, and how many opening picks to require. */
leaguesRouter.patch('/:leagueId', requireLeagueAdmin, wrap(async (req, res) => {
  const body = parse(brandingSchema, req.body);
  const league = req.league;
  const context = leagueContext(league);
  const isSuperAdmin = req.leagueRole === 'super_admin';

  // Once setup is locked, the league admin is done editing: the look and the
  // rules are what the entrants signed up to. The super admin can still amend.
  if (context.configLocked && !isSuperAdmin) {
    throw conflict(
      context.configLockReason === 'competition_started'
        ? 'Setup locked when the competition kicked off. Ask the platform admin if something has to change.'
        : 'Setup is locked. Ask the platform admin to reopen it if something has to change.',
      { code: 'config_locked' },
    );
  }


  // An upload and a ready-made crest are alternatives: choosing one clears the other.
  let logo = { buffer: undefined, mime: undefined };
  let preset = body.logoPreset === undefined ? league.logo_preset : body.logoPreset;
  if (body.logo !== undefined) {
    logo = body.logo === null ? { buffer: null, mime: null } : decodeLogo(body.logo);
    if (logo.buffer) preset = null;
  }
  if (body.logoPreset) logo = { buffer: null, mime: null };

  // Moving the start gameweek re-dates every round, so it is only safe while
  // the league has not been played.
  if (body.startGameweek !== undefined && body.startGameweek !== league.start_gameweek) {
    if (get('SELECT 1 FROM picks WHERE league_id = ?', league.id)) {
      throw conflict('Picks have already been made — moving the start gameweek would invalidate them');
    }
    if (!get('SELECT 1 FROM gameweeks WHERE season_id = ? AND number = ?', league.season_id, body.startGameweek)) {
      throw notFound(`Gameweek ${body.startGameweek} does not exist in this season`);
    }
  }

  run(
    `UPDATE leagues SET name = ?, tagline = ?, primary_color = ?, secondary_color = ?, opening_picks = ?,
            logo_data = ?, logo_mime = ?, logo_preset = ?, start_gameweek = ?,
            draw_policy = ?, void_policy = ?, no_pick_policy = ?, anonymous_entrants = ?
     WHERE id = ?`,
    body.name ?? league.name,
    body.tagline === undefined ? league.tagline : body.tagline,
    body.primaryColor ?? league.primary_color,
    body.secondaryColor ?? league.secondary_color,
    body.openingPicks ?? league.opening_picks,
    logo.buffer === undefined ? league.logo_data : logo.buffer,
    logo.buffer === undefined ? league.logo_mime : logo.mime,
    preset,
    body.startGameweek ?? league.start_gameweek,
    body.drawPolicy ?? league.draw_policy,
    body.voidPolicy ?? league.void_policy,
    body.noPickPolicy ?? league.no_pick_policy,
    body.anonymousEntrants === undefined ? league.anonymous_entrants : Number(body.anonymousEntrants),
    league.id,
  );
  audit(req.user.id, 'league.branding_updated', 'league', league.id, {
    name: body.name, tagline: body.tagline, primaryColor: body.primaryColor,
    secondaryColor: body.secondaryColor, openingPicks: body.openingPicks,
    startGameweek: body.startGameweek, drawPolicy: body.drawPolicy, voidPolicy: body.voidPolicy,
    noPickPolicy: body.noPickPolicy, anonymousEntrants: body.anonymousEntrants,
    logo: body.logo === undefined ? 'unchanged' : body.logo === null ? 'cleared' : 'updated',
    logoPreset: preset,
    // Worth recording separately: an edit that went through a closed lock.
    supersededLock: context.configLocked && isSuperAdmin,
  });
  const updated = get('SELECT * FROM leagues WHERE id = ?', league.id);
  res.json({ league: summarise(updated, leagueContext(updated), req.entry, req.leagueRole) });
}));

/** Finish setup: the look and the rules stop being editable by the admin. */
leaguesRouter.post('/:leagueId/lock', requireLeagueAdmin, wrap(async (req, res) => {
  if (req.league.config_locked_at && req.league.launched_at) {
    return res.json({
      ok: true, alreadyLocked: true,
      lockedAt: req.league.config_locked_at, launchedAt: req.league.launched_at,
    });
  }
  const lockedAt = nowIso();
  // Launching and locking are the same act: confirming the setup is what turns
  // a draft into a league people can be invited to.
  run(
    `UPDATE leagues SET config_locked_at = ?, config_locked_by = ?,
            launched_at = COALESCE(launched_at, ?), launched_by = COALESCE(launched_by, ?)
     WHERE id = ?`,
    lockedAt, req.user.id, lockedAt, req.user.id, req.league.id,
  );
  audit(req.user.id, 'league.launched', 'league', req.league.id, null);
  const updated = get('SELECT * FROM leagues WHERE id = ?', req.league.id);
  res.json({ ok: true, lockedAt, launchedAt: updated.launched_at, joinCode: updated.join_code });
}));

/**
 * The league admin's only route through a lock: ask. They cannot override it,
 * and a request that vanished into an inbox is how an admin ends up wanting to,
 * so it is recorded against the league as well as emailed.
 */
leaguesRouter.post('/:leagueId/change-request', requireLeagueAdmin, wrap(async (req, res) => {
  const context = leagueContext(req.league);
  if (!context.configLocked) {
    throw badRequest('This league is not locked — you can make the change yourself');
  }
  const body = parse(z.object({ message: z.string().trim().min(10).max(1000) }), req.body);
  const { request, notified } = requestChange({ league: req.league, user: req.user, message: body.message });
  res.status(201).json({ request, notified });
}));

leaguesRouter.get('/:leagueId/change-requests', requireLeagueAdmin, wrap(async (req, res) => {
  res.json({ requests: changeRequestsFor(req.league.id) });
}));

/** Reopen setup. Platform admin only — that is the point of the lock. */
leaguesRouter.post('/:leagueId/unlock', requireLeagueAdmin, wrap(async (req, res) => {
  if (req.leagueRole !== 'super_admin') {
    throw forbidden('Only the platform admin can reopen a locked league');
  }
  const body = parse(z.object({ reason: z.string().trim().min(3).max(200) }), req.body);
  run('UPDATE leagues SET config_locked_at = NULL, config_locked_by = NULL WHERE id = ?', req.league.id);
  audit(req.user.id, 'league.config_unlocked', 'league', req.league.id, { reason: body.reason });
  // Reopening the setup answers whatever the admin was waiting on.
  resolveOpenRequestsFor(req.league.id, req.user, 'The setup has been reopened for you.');

  const admin = req.league.admin_user_id
    ? get('SELECT * FROM users WHERE id = ?', req.league.admin_user_id)
    : null;
  if (admin) {
    queueDirect(admin, {
      kind: 'config_unlocked',
      league: req.league,
      subject: `${req.league.name}: setup reopened`,
      body: [
        `Hi ${admin.display_name},`,
        '',
        `${req.user.display_name} has reopened the setup for ${req.league.name}: ${body.reason}`,
        'Make your changes and lock it again when you are done.',
        '',
        `${config.publicUrl}/leagues/${req.league.id}/admin`,
      ].join('\n'),
    });
  }
  const context = leagueContext(req.league);
  res.json({
    ok: true,
    // The competition starting locks it regardless of this flag.
    stillLocked: context.entryClosed,
  });
}));

/**
 * Wave an eliminated player back in. Special circumstances happen — a fixture
 * chaos week, a pick that never saved — and the league admin is the one who
 * hears about it.
 */
leaguesRouter.post('/:leagueId/members/:entryId/reinstate', requireLeagueAdmin, wrap(async (req, res) => {
  const body = parse(z.object({ reason: z.string().trim().min(3).max(200) }), req.body);
  const entry = get('SELECT * FROM entries WHERE id = ? AND league_id = ?',
    Number(req.params.entryId), req.league.id);
  if (!entry) throw notFound('That player is not in this league');
  if (entry.status === 'active') throw conflict('They are still in — nothing to reinstate');

  run(
    `UPDATE entries SET status = 'active', eliminated_round = NULL, eliminated_reason = NULL,
            eliminated_at = NULL, reinstated_at = ?, reinstated_by = ?, reinstated_reason = ?
     WHERE id = ?`,
    nowIso(), req.user.id, body.reason, entry.id,
  );
  // Reopening a league that had already crowned a winner.
  if (req.league.status === 'completed') {
    run("UPDATE leagues SET status = 'active', completed_at = NULL WHERE id = ?", req.league.id);
    run('UPDATE entries SET is_winner = 0 WHERE league_id = ?', req.league.id);
  }

  const user = get('SELECT * FROM users WHERE id = ?', entry.user_id);
  if (user) {
    queueDirect(user, {
      kind: 'reinstated',
      league: req.league,
      subject: `${req.league.name}: you are back in`,
      body: [
        `Hi ${user.display_name},`,
        '',
        `${req.user.display_name} has put you back into ${req.league.name}: ${body.reason}`,
        'Make your pick for the next round to stay in it.',
        '',
        `${config.publicUrl}/leagues/${req.league.id}`,
      ].join('\n'),
    });
  }
  audit(req.user.id, 'league.member_reinstated', 'entry', entry.id, {
    leagueId: req.league.id, reason: body.reason,
  });
  res.json({ ok: true, entry: get('SELECT * FROM entries WHERE id = ?', entry.id) });
}));

/**
 * Everything this league has sent, grouped, with the admin's own announcements
 * marked apart from the ones the league sent by itself.
 */
leaguesRouter.get('/:leagueId/announcements', requireLeagueAdmin, wrap(async (req, res) => {
  res.json({ batches: leagueOutbox(req.league.id) });
}));

/** League admins can message their players (e.g. a nudge before a deadline). */
leaguesRouter.post('/:leagueId/announce', requireLeagueAdmin, wrap(async (req, res) => {
  if (!req.league.launched_at) {
    throw conflict('Launch the league before announcing anything — nobody has joined yet');
  }
  const body = parse(
    z.object({ subject: z.string().trim().min(3).max(120), message: z.string().trim().min(3).max(2000) }),
    req.body,
  );
  const users = all(
    `SELECT u.* FROM entries e JOIN users u ON u.id = e.user_id WHERE e.league_id = ?`,
    req.league.id,
  );
  // One timestamp for the whole send, so the log shows one announcement rather
  // than however many milliseconds the loop happened to span.
  const sentAt = nowIso();
  let queued = 0;
  for (const user of users) {
    queued += queueDirect(user, {
      kind: 'announcement',
      league: req.league,
      subject: `${req.league.name}: ${body.subject}`,
      body: `${body.message}\n\n— ${req.user.display_name}`,
      dedupeKey: `announce:${req.league.id}:${user.id}:${sentAt}`,
      scheduledFor: sentAt,
    });
  }
  audit(req.user.id, 'league.announce', 'league', req.league.id, { recipients: users.length });
  res.json({ ok: true, queued });
}));

