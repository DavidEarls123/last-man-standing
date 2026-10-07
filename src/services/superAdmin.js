import bcrypt from 'bcryptjs';
import { get, run, audit, transaction } from '../db/index.js';
import { hashPassword, randomCode } from '../lib/auth.js';
import { generateSecret } from '../lib/totp.js';
import { nowIso } from '../lib/time.js';

/**
 * Creating the one platform super admin, shared by the interactive CLI and the
 * automatic setup a hosted deployment does on first boot. Both need the same
 * thing to happen; only the way the details arrive differs.
 */
export async function createOrResetSuperAdmin({ email, phone = null, name = 'Super Admin', password }) {
  const existing = get('SELECT * FROM users WHERE is_super_admin = 1');
  const codes = Array.from({ length: 10 }, () => `${randomCode(5)}-${randomCode(5)}`);
  const codeHashes = await Promise.all(codes.map((code) => bcrypt.hash(code.replace(/-/g, ''), 12)));
  const passwordHash = await hashPassword(password);
  const totpSecret = generateSecret();

  const userId = transaction(() => {
    let id = existing?.id;
    if (existing) {
      run(
        `UPDATE users SET email = ?, phone = ?, display_name = ?, password_hash = ?, totp_secret = ?,
                totp_enabled = 0, token_version = token_version + 1, status = 'active',
                failed_logins = 0, locked_until = NULL
         WHERE id = ?`,
        email || null, phone || null, name, passwordHash, totpSecret, existing.id,
      );
    } else {
      const result = run(
        `INSERT INTO users (email, phone, display_name, password_hash, is_super_admin, totp_secret,
                            notify_email, notify_sms, created_at)
         VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?)`,
        email || null, phone || null, name, passwordHash, totpSecret, phone ? 1 : 0, nowIso(),
      );
      id = Number(result.lastInsertRowid);
    }
    run('DELETE FROM recovery_codes WHERE user_id = ?', id);
    for (const hash of codeHashes) {
      run('INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)', id, hash, nowIso());
    }
    return id;
  });

  audit(userId, existing ? 'superadmin.reset' : 'superadmin.created', 'user', userId, null);
  return { userId, totpSecret, codes, replaced: Boolean(existing) };
}
