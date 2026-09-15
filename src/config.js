import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

/**
 * Minimal .env loader so the app runs with no extra dependency.
 *
 * Values are trimmed before use. A file written on Windows carries a CR at the
 * end of every line, and `echo KEY=value > .env` in Command Prompt leaves a
 * trailing space — either one silently corrupts an API key and turns a working
 * setup into an unexplained 401.
 */
export function loadEnvFile(file, env = process.env) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const match = /^\s*([A-Z0-9_]+)\s*=(.*)$/i.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (env[key] !== undefined) continue;
    env[key] = rawValue.trim().replace(/^["'](.*)["']$/, '$1');
  }
}
loadEnvFile(path.join(root, '.env'));

const isProduction = process.env.NODE_ENV === 'production';

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (isProduction) {
    throw new Error('SESSION_SECRET must be set in production (see .env.example)');
  }
  // Persist a development secret so restarts do not log everyone out.
  const file = path.join(root, 'data', '.dev-session-secret');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

export const config = {
  root,
  isProduction,
  port: Number(process.env.PORT || 3000),
  databaseFile: process.env.DATABASE_FILE || path.join(root, 'data', 'lms.sqlite'),
  sessionSecret: sessionSecret(),
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS || 14),
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${Number(process.env.PORT || 3000)}`,
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 12),

  // Football data provider: `local` keeps fixtures/results in this database
  // (entered by the super admin or driven by the simulator); `football-data`
  // pulls live Premier League data from football-data.org.
  football: {
    provider: process.env.FOOTBALL_PROVIDER || 'local',
    apiKey: process.env.FOOTBALL_DATA_API_KEY || '',
    competition: process.env.FOOTBALL_DATA_COMPETITION || 'PL',
    pollSeconds: Number(process.env.FOOTBALL_POLL_SECONDS || 60),
    simulate: process.env.SIMULATE_LIVE === 'true',
  },

  email: {
    provider: process.env.EMAIL_PROVIDER || 'console', // console | smtp
    from: process.env.EMAIL_FROM || 'Last One Standing <no-reply@example.com>',
    smtpUrl: process.env.SMTP_URL || '',
  },

  sms: {
    provider: process.env.SMS_PROVIDER || 'console', // console | twilio
    from: process.env.TWILIO_FROM || '',
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
  },
};
