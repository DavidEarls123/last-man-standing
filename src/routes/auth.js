import express from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { all, get, run, audit } from '../db/index.js';
import {
  SESSION_COOKIE, checkPasswordStrength, cookieOptions, hashPassword, randomToken,
  sha256, signToken, verifyPassword,
} from '../lib/auth.js';
import { generateSecret, otpauthUrl, verifyTotp } from '../lib/totp.js';
import { badRequest, conflict, forbidden, unauthorized } from '../lib/errors.js';
import { emailSchema, parse, phoneSchema, wrap } from '../lib/validate.js';
import { nowIso } from '../lib/time.js';
import { config } from '../config.js';
import { rateLimit, requireAuth } from '../middleware/auth.js';
import { queueDirect } from '../services/notifications.js';

export const authRouter = express.Router();

const LOCKOUT_THRESHOLD = 8;
const LOCKOUT_MINUTES = 15;

export const publicUser = (user) => ({
  id: user.id,
  displayName: user.display_name,
  email: user.email,
  phone: user.phone,
  isSuperAdmin: Boolean(user.is_super_admin),
  totpEnabled: Boolean(user.totp_enabled),
  notifyEmail: Boolean(user.notify_email),
  notifySms: Boolean(user.notify_sms),
  createdAt: user.created_at,
});

const registerSchema = z
  .object({
    displayName: z.string().trim().min(2).max(60),
    email: emailSchema.optional().or(z.literal('').transform(() => undefined)),
    phone: phoneSchema.optional().or(z.literal('').transform(() => undefined)),
    password: z.string().min(1),
    joinCode: z.string().trim().toUpperCase().optional(),
  })
  .refine((value) => value.email || value.phone, {
    message: 'Give an email address or a mobile number',
    path: ['email'],
  });

function issueSession(res, user) {
  res.cookie(SESSION_COOKIE, signToken(user), cookieOptions());
}

authRouter.post('/register', rateLimit({ max: 15 }), wrap(async (req, res) => {
  const body = parse(registerSchema, req.body);
  const strength = checkPasswordStrength(body.password);
  if (!strength.ok) throw badRequest(`Password ${strength.problems.join(', ')}`);

  if (body.email && get('SELECT 1 FROM users WHERE email = ?', body.email)) {
    throw conflict('An account already exists for that email address');
  }
  if (body.phone && get('SELECT 1 FROM users WHERE phone = ?', body.phone)) {
    throw conflict('An account already exists for that phone number');
  }

  const result = run(
    `INSERT INTO users (email, phone, display_name, password_hash, notify_email, notify_sms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    body.email ?? null, body.phone ?? null, body.displayName, await hashPassword(body.password),
    body.email ? 1 : 0, body.phone ? 1 : 0, nowIso(),
  );
  const user = get('SELECT * FROM users WHERE id = ?', Number(result.lastInsertRowid));
  audit(user.id, 'user.register', 'user', user.id, null);
  issueSession(res, user);
  res.status(201).json({ user: publicUser(user) });
}));

const loginSchema = z.object({
  identifier: z.string().trim().min(3),
  password: z.string().min(1),
  totp: z.string().trim().optional(),
});

function findByIdentifier(identifier) {
  const value = identifier.trim();
  const asEmail = value.toLowerCase();
  const byEmail = get('SELECT * FROM users WHERE email = ?', asEmail);
  if (byEmail) return byEmail;
  const digits = value.replace(/[\s()-]/g, '');
  const e164 = digits.startsWith('+') ? digits : digits.startsWith('0') ? `+44${digits.slice(1)}` : `+${digits}`;
  return get('SELECT * FROM users WHERE phone = ?', e164);
}

authRouter.post('/login', rateLimit({ max: 20 }), wrap(async (req, res) => {
  const body = parse(loginSchema, req.body);
  const user = findByIdentifier(body.identifier);
  const genericFailure = unauthorized('Email/phone or password is incorrect');
  if (!user) {
    await bcrypt.compare(body.password, '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu');
    throw genericFailure;
  }
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    throw forbidden('Account temporarily locked after too many failed attempts. Try again shortly.');
  }
  if (user.status !== 'active') throw forbidden('This account is suspended. Contact your league admin.');

  if (!(await verifyPassword(body.password, user.password_hash))) {
    const failures = user.failed_logins + 1;
    run(
      'UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?',
      failures,
      failures >= LOCKOUT_THRESHOLD ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString() : null,
      user.id,
    );
    audit(user.id, 'auth.login_failed', 'user', user.id, { failures });
    throw genericFailure;
  }

  if (user.totp_enabled) {
    if (!body.totp) {
      return res.status(401).json({ error: { code: 'totp_required', message: 'Enter your authenticator code' } });
    }
    if (!verifyTotp(user.totp_secret, body.totp)) {
      audit(user.id, 'auth.totp_failed', 'user', user.id, null);
      throw unauthorized('That authenticator code is not valid');
    }
  } else if (user.is_super_admin) {
    // Super admin accounts must enrol a second factor; the UI prompts on next load.
    audit(user.id, 'auth.super_admin_no_totp', 'user', user.id, null);
  }

  run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', user.id);
  audit(user.id, 'auth.login', 'user', user.id, null);
  issueSession(res, user);
  res.json({ user: publicUser(user) });
}));

authRouter.post('/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: publicUser(req.user) });
});

const profileSchema = z.object({
  displayName: z.string().trim().min(2).max(60).optional(),
  email: emailSchema.optional().nullable(),
  phone: phoneSchema.optional().nullable(),
  notifyEmail: z.boolean().optional(),
  notifySms: z.boolean().optional(),
});

authRouter.patch('/me', requireAuth, wrap(async (req, res) => {
  const body = parse(profileSchema, req.body);
  const user = req.user;

  if (body.email !== undefined && body.email !== user.email) {
    if (body.email && get('SELECT 1 FROM users WHERE email = ? AND id != ?', body.email, user.id)) {
      throw conflict('That email address is already in use');
    }
  }
  if (body.phone !== undefined && body.phone !== user.phone) {
    if (body.phone && get('SELECT 1 FROM users WHERE phone = ? AND id != ?', body.phone, user.id)) {
      throw conflict('That phone number is already in use');
    }
  }
  const email = body.email === undefined ? user.email : body.email;
  const phone = body.phone === undefined ? user.phone : body.phone;
  if (!email && !phone) throw badRequest('Keep at least one of email or phone on your account');

  run(
    `UPDATE users SET display_name = ?, email = ?, phone = ?, notify_email = ?, notify_sms = ? WHERE id = ?`,
    body.displayName ?? user.display_name, email, phone,
    body.notifyEmail === undefined ? user.notify_email : Number(body.notifyEmail),
    body.notifySms === undefined ? user.notify_sms : Number(body.notifySms),
    user.id,
  );
  res.json({ user: publicUser(get('SELECT * FROM users WHERE id = ?', user.id)) });
}));

authRouter.post('/me/password', requireAuth, rateLimit({ max: 10 }), wrap(async (req, res) => {
  const body = parse(z.object({ current: z.string(), password: z.string() }), req.body);
  if (!(await verifyPassword(body.current, req.user.password_hash))) {
    throw unauthorized('Current password is incorrect');
  }
  const strength = checkPasswordStrength(body.password, { superAdmin: Boolean(req.user.is_super_admin) });
  if (!strength.ok) throw badRequest(`Password ${strength.problems.join(', ')}`);

  run(
    'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?',
    await hashPassword(body.password), req.user.id,
  );
  audit(req.user.id, 'auth.password_changed', 'user', req.user.id, null);
  issueSession(res, get('SELECT * FROM users WHERE id = ?', req.user.id));
  res.json({ ok: true });
}));

// ------------------------------------------------------------ second factor --

authRouter.post('/me/totp/setup', requireAuth, wrap(async (req, res) => {
  const secret = generateSecret();
  run('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?', secret, req.user.id);
  res.json({
    secret,
    otpauthUrl: otpauthUrl({ secret, account: req.user.email || req.user.phone || req.user.display_name }),
  });
}));

authRouter.post('/me/totp/enable', requireAuth, wrap(async (req, res) => {
  const body = parse(z.object({ code: z.string() }), req.body);
  const user = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!user.totp_secret) throw badRequest('Start with /me/totp/setup');
  if (!verifyTotp(user.totp_secret, body.code)) throw badRequest('That code is not valid — check your device clock');
  run('UPDATE users SET totp_enabled = 1 WHERE id = ?', user.id);
  audit(user.id, 'auth.totp_enabled', 'user', user.id, null);
  res.json({ ok: true });
}));

authRouter.post('/me/totp/disable', requireAuth, wrap(async (req, res) => {
  const body = parse(z.object({ password: z.string() }), req.body);
  if (!(await verifyPassword(body.password, req.user.password_hash))) throw unauthorized('Password is incorrect');
  if (req.user.is_super_admin) throw forbidden('The super admin must keep two-factor authentication on');
  run('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', req.user.id);
  audit(req.user.id, 'auth.totp_disabled', 'user', req.user.id, null);
  res.json({ ok: true });
}));

// ----------------------------------------------------------------- recovery --

authRouter.post('/forgot', rateLimit({ max: 10 }), wrap(async (req, res) => {
  const body = parse(z.object({ identifier: z.string().trim().min(3) }), req.body);
  const user = findByIdentifier(body.identifier);
  // Always answer the same way so the endpoint cannot enumerate accounts.
  if (user) {
    const token = randomToken();
    run(
      `INSERT INTO password_resets (user_id, token_hash, channel, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      user.id, sha256(token), user.email ? 'email' : 'sms',
      new Date(Date.now() + 60 * 60_000).toISOString(), nowIso(),
    );
    const link = `${config.publicUrl}/reset?token=${token}`;
    queueDirect(user, {
      kind: 'password_reset',
      subject: 'Reset your Last Man Standing password',
      body: `Use this link within the hour to set a new password:\n\n${link}\n\nIf you did not ask for this, ignore this message.`,
    });
    audit(user.id, 'auth.reset_requested', 'user', user.id, null);
  }
  res.json({ ok: true, message: 'If that account exists, a reset link is on its way.' });
}));

authRouter.post('/reset', rateLimit({ max: 15 }), wrap(async (req, res) => {
  const body = parse(z.object({ token: z.string().min(10), password: z.string() }), req.body);
  const record = get('SELECT * FROM password_resets WHERE token_hash = ?', sha256(body.token));
  if (!record || record.used_at || new Date(record.expires_at).getTime() < Date.now()) {
    throw badRequest('That reset link has expired — request a new one');
  }
  const user = get('SELECT * FROM users WHERE id = ?', record.user_id);
  const strength = checkPasswordStrength(body.password, { superAdmin: Boolean(user.is_super_admin) });
  if (!strength.ok) throw badRequest(`Password ${strength.problems.join(', ')}`);

  run('UPDATE users SET password_hash = ?, token_version = token_version + 1, failed_logins = 0, locked_until = NULL WHERE id = ?',
    await hashPassword(body.password), user.id);
  run('UPDATE password_resets SET used_at = ? WHERE id = ?', nowIso(), record.id);
  audit(user.id, 'auth.password_reset', 'user', user.id, null);
  res.json({ ok: true });
}));

/**
 * Break-glass sign in for the super admin using one of the one-time recovery
 * codes issued at bootstrap. Clears the second factor so a lost authenticator
 * can be re-enrolled, and burns the code.
 */
authRouter.post('/recovery', rateLimit({ max: 5, windowMs: 60 * 60_000 }), wrap(async (req, res) => {
  const body = parse(
    z.object({ identifier: z.string().trim().min(3), code: z.string().trim().min(6), password: z.string() }),
    req.body,
  );
  const user = findByIdentifier(body.identifier);
  if (!user || !user.is_super_admin) throw unauthorized('Recovery code not recognised');

  const codes = all('SELECT * FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', user.id);
  let matched = null;
  for (const candidate of codes) {
    if (await bcrypt.compare(body.code.replace(/[\s-]/g, '').toUpperCase(), candidate.code_hash)) {
      matched = candidate;
      break;
    }
  }
  if (!matched) {
    audit(user.id, 'auth.recovery_failed', 'user', user.id, null);
    throw unauthorized('Recovery code not recognised');
  }

  const strength = checkPasswordStrength(body.password, { superAdmin: true });
  if (!strength.ok) throw badRequest(`Password ${strength.problems.join(', ')}`);

  run('UPDATE recovery_codes SET used_at = ? WHERE id = ?', nowIso(), matched.id);
  run(
    `UPDATE users SET password_hash = ?, token_version = token_version + 1, totp_enabled = 0,
            totp_secret = NULL, failed_logins = 0, locked_until = NULL WHERE id = ?`,
    await hashPassword(body.password), user.id,
  );
  audit(user.id, 'auth.recovery_used', 'user', user.id, { remaining: codes.length - 1 });
  const refreshed = get('SELECT * FROM users WHERE id = ?', user.id);
  issueSession(res, refreshed);
  res.json({
    user: publicUser(refreshed),
    remainingCodes: codes.length - 1,
    message: 'Recovery code accepted. Re-enrol your authenticator app now.',
  });
}));
