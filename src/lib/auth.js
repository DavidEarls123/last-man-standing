import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export const hashPassword = (plain) => bcrypt.hash(plain, config.bcryptRounds);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), tv: user.token_version, sa: Boolean(user.is_super_admin) },
    config.sessionSecret,
    { expiresIn: `${config.sessionTtlDays}d` },
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.sessionSecret);
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = 'lms_session';

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/',
    maxAge: config.sessionTtlDays * 24 * 60 * 60 * 1000,
  };
}

/** Human-friendly, unambiguous codes (no O/0/I/1). Used for join codes and recovery codes. */
export function randomCode(length = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/**
 * Password policy. The super admin is held to a much longer minimum because a
 * single compromised credential would expose every league on the platform.
 */
export function checkPasswordStrength(password, { superAdmin = false } = {}) {
  const min = superAdmin ? 20 : 10;
  const problems = [];
  if (typeof password !== 'string' || password.length < min) {
    problems.push(`must be at least ${min} characters`);
  }
  if (superAdmin) {
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password || '')).length;
    if (classes < 3) problems.push('must mix upper case, lower case, digits and symbols');
  }
  if (/^(.)\1+$/.test(password || '')) problems.push('must not be a single repeated character');
  return { ok: problems.length === 0, problems };
}
