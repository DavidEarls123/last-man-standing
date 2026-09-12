import { get, run, audit } from '../db/index.js';
import { checkPasswordStrength, hashPassword } from '../lib/auth.js';
import { ask, flag } from './prompt.js';

/**
 * Offline break-glass: whoever has shell access to the server can set a new
 * super admin passphrase and clear the second factor. This is the recovery
 * path of last resort — it cannot be phished, because it never touches the web.
 *
 *   npm run superadmin:reset
 */
async function main() {
  const user = get('SELECT * FROM users WHERE is_super_admin = 1');
  if (!user) {
    console.error('No super admin exists. Run `npm run bootstrap` instead.');
    process.exit(1);
  }
  console.log(`Resetting credentials for: ${user.email || user.phone} (${user.display_name})`);

  let password = String(flag('password') || '');
  while (true) {
    if (!password) password = await ask('New passphrase (20+ chars): ', { silent: true });
    const strength = checkPasswordStrength(password, { superAdmin: true });
    if (strength.ok) break;
    console.error(`Passphrase ${strength.problems.join(', ')}`);
    password = '';
  }

  const clearTotp = flag('clear-totp', false);
  run(
    `UPDATE users SET password_hash = ?, token_version = token_version + 1, failed_logins = 0,
            locked_until = NULL, totp_enabled = ?, totp_secret = CASE WHEN ? THEN NULL ELSE totp_secret END
     WHERE id = ?`,
    await hashPassword(password), clearTotp ? 0 : user.totp_enabled, clearTotp ? 1 : 0, user.id,
  );
  audit(user.id, 'superadmin.password_reset_cli', 'user', user.id, { clearTotp: Boolean(clearTotp) });

  console.log('Passphrase updated and every existing session signed out.');
  if (clearTotp) console.log('Two-factor cleared — re-enrol an authenticator after signing in.');
  else console.log('Two-factor left in place. Add --clear-totp if you also lost your authenticator.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
