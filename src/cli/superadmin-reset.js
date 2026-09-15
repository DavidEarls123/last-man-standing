import bcrypt from 'bcryptjs';
import { get, run, audit, transaction } from '../db/index.js';
import { checkPasswordStrength, hashPassword, randomCode } from '../lib/auth.js';
import { nowIso } from '../lib/time.js';
import { ask, flag } from './prompt.js';

/**
 * Offline break-glass: whoever has shell access to the server can set a new
 * super admin passphrase and clear the second factor. This is the recovery
 * path of last resort — it cannot be phished, because it never touches the web.
 *
 *   npm run superadmin:reset
 *   npm run superadmin:reset -- --clear-totp --new-codes
 *
 * A passphrase reset deliberately leaves the recovery codes alone: they are the
 * other way back in, and rotating them silently would strand whoever is holding
 * the printout. When the codes themselves are the problem — seen over a
 * shoulder, photographed, mailed to somebody — `--new-codes` replaces them.
 */
async function main() {
  const user = get('SELECT * FROM users WHERE is_super_admin = 1');
  if (!user) {
    console.error('No super admin exists. Run `npm run bootstrap` instead.');
    process.exit(1);
  }
  console.log(`Resetting credentials for: ${user.email || user.phone} (${user.display_name})`);

  let password = String(flag('password') ?? '');
  while (true) {
    if (!password) password = await ask('New passphrase (20+ chars): ', { silent: true });
    const strength = checkPasswordStrength(password, { superAdmin: true });
    if (strength.ok) break;
    console.error(`Passphrase ${strength.problems.join(', ')}`);
    password = '';
  }

  const clearTotp = flag('clear-totp', false);
  const newCodes = flag('new-codes', false);

  const passwordHash = await hashPassword(password);
  const codes = newCodes
    ? Array.from({ length: 10 }, () => `${randomCode(5)}-${randomCode(5)}`)
    : [];
  const codeHashes = await Promise.all(codes.map((code) => bcrypt.hash(code.replace(/-/g, ''), 12)));

  transaction(() => {
    run(
      `UPDATE users SET password_hash = ?, token_version = token_version + 1, failed_logins = 0,
              locked_until = NULL, totp_enabled = ?, totp_secret = CASE WHEN ? THEN NULL ELSE totp_secret END
       WHERE id = ?`,
      passwordHash, clearTotp ? 0 : user.totp_enabled, clearTotp ? 1 : 0, user.id,
    );
    if (newCodes) {
      run('DELETE FROM recovery_codes WHERE user_id = ?', user.id);
      for (const hash of codeHashes) {
        run('INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)',
          user.id, hash, nowIso());
      }
    }
  });
  audit(user.id, 'superadmin.password_reset_cli', 'user', user.id, {
    clearTotp: Boolean(clearTotp), newCodes: Boolean(newCodes),
  });

  console.log('Passphrase updated and every existing session signed out.');
  if (clearTotp) console.log('Two-factor cleared — re-enrol an authenticator after signing in.');
  else console.log('Two-factor left in place. Add --clear-totp if you also lost your authenticator.');

  // Said either way. A reset that silently leaves a live way in is worse than
  // one that does nothing, because you think you are covered.
  if (!newCodes) {
    const remaining = get(
      'SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', user.id,
    ).n;
    console.log(`Recovery codes UNCHANGED — ${remaining} still work. Add --new-codes to replace them.`);
    return;
  }
  console.log('\n  NEW RECOVERY CODES — the old ones no longer work.');
  console.log('  Printed once, store them offline:');
  for (const code of codes) console.log(`    ${code}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
