import { get } from '../db/index.js';
import { checkPasswordStrength } from '../lib/auth.js';
import { otpauthUrl } from '../lib/totp.js';
import { createOrResetSuperAdmin } from '../services/superAdmin.js';
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

  const { totpSecret, codes } = await createOrResetSuperAdmin({ email, phone, name, password });

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
