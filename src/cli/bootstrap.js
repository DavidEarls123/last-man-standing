import bcrypt from 'bcryptjs';
import { get, run, audit, transaction } from '../db/index.js';
import { checkPasswordStrength, hashPassword, randomCode } from '../lib/auth.js';
import { generateSecret, otpauthUrl } from '../lib/totp.js';
import { nowIso } from '../lib/time.js';
import { ask, flag } from './prompt.js';

/**
 * Creates the single platform super admin. Run once after install:
 *   npm run bootstrap
 * Re-running with --force resets the existing super admin's credentials, which
 * is the supported "I am locked out but I still have server access" path.
 */
async function main() {
  const existing = get('SELECT * FROM users WHERE is_super_admin = 1');
  const force = flag('force', false);
  if (existing && !force) {
    console.log(`A super admin already exists: ${existing.email || existing.phone}`);
    console.log('Use `npm run bootstrap -- --force` to reset it, or `npm run superadmin:reset` to change the password only.');
    process.exit(1);
  }

  // A flag that is present but empty (--phone=) means "leave this blank",
  // so only fall back to a prompt when the flag is absent altogether.
  const answer = async (name, question) => {
    const provided = flag(name);
    return String(provided === undefined ? await ask(question) : provided).trim();
  };

  const email = (await answer('email', 'Super admin email: ')).toLowerCase();
  const phone = await answer('phone', 'Super admin mobile (optional, +44...): ');
  const name = (await answer('name', 'Display name [Super Admin]: ')) || 'Super Admin';

  let password = String(flag('password') ?? '');
  while (true) {
    if (!password) password = await ask('Passphrase (20+ chars, mixed case/digits/symbols): ', { silent: true });
    const strength = checkPasswordStrength(password, { superAdmin: true });
    if (strength.ok) break;
    console.error(`Passphrase ${strength.problems.join(', ')}`);
    password = '';
  }

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

  console.log('\n=========================================================');
  console.log(' SUPER ADMIN READY');
  console.log('=========================================================');
  console.log(`  Sign in with: ${email || phone}`);
  console.log('\n  Two-factor secret (add to your authenticator app now):');
  console.log(`    ${totpSecret}`);
  console.log(`    ${otpauthUrl({ secret: totpSecret, account: email || phone || name })}`);
  console.log('  Then confirm it in the app under Account -> Two-factor.');
  console.log('\n  RECOVERY CODES — printed once, store them offline:');
  for (const code of codes) console.log(`    ${code}`);
  console.log('\n  Each code works once, unlocks the account without the');
  console.log('  authenticator, and forces a new passphrase.');
  console.log('=========================================================\n');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
