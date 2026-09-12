import { get } from '../db/index.js';
import { SESSION_COOKIE, verifyToken } from '../lib/auth.js';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';

export function attachUser(req, res, next) {
  req.user = null;
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return next();
  const claims = verifyToken(token);
  if (!claims) return next();

  const user = get('SELECT * FROM users WHERE id = ?', Number(claims.sub));
  if (!user || user.status !== 'active' || user.token_version !== claims.tv) return next();
  req.user = user;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

export function requireSuperAdmin(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (!req.user.is_super_admin) return next(forbidden('Super admin only'));
  next();
}

/**
 * Blocks cross-site form posts. Combined with SameSite=Lax cookies this keeps
 * state-changing requests same-origin without a token round trip.
 */
export function requireSameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'lms-web') {
    return next(forbidden('Missing X-Requested-With header'));
  }
  next();
}

/** Loads req.league and works out what the caller may do with it. */
export function loadLeague(req, res, next) {
  const league = get('SELECT * FROM leagues WHERE id = ?', Number(req.params.leagueId));
  if (!league) return next(notFound('League not found'));
  req.league = league;
  req.entry = req.user
    ? get('SELECT * FROM entries WHERE league_id = ? AND user_id = ?', league.id, req.user.id)
    : null;
  req.leagueRole = !req.user
    ? 'guest'
    : req.user.is_super_admin
      ? 'super_admin'
      : league.admin_user_id === req.user.id
        ? 'admin'
        : req.entry ? 'player' : 'guest';
  next();
}

export function requireLeagueMember(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (req.leagueRole === 'guest') return next(forbidden('You are not in this league'));
  next();
}

export function requireLeagueAdmin(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (req.leagueRole !== 'admin' && req.leagueRole !== 'super_admin') {
    return next(forbidden('League admin only'));
  }
  next();
}

/** Crude in-memory throttle for credential endpoints. */
const attempts = new Map();
export function rateLimit({ windowMs = 15 * 60_000, max = 20, key = (req) => req.ip } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = `${req.path}:${key(req)}`;
    const bucket = attempts.get(bucketKey) ?? { count: 0, resetAt: now + windowMs };
    if (bucket.resetAt < now) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }
    bucket.count += 1;
    attempts.set(bucketKey, bucket);
    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return next(Object.assign(new Error('Too many attempts, please wait'), { status: 429, code: 'too_many' }));
    }
    next();
  };
}
