import { get } from './db/index.js';
import { config } from './config.js';
import { seedSeason } from './db/seed.js';
import { footballProvider } from './services/football/index.js';
import { checkPasswordStrength } from './lib/auth.js';
import { otpauthUrl } from './lib/totp.js';
import { createOrResetSuperAdmin } from './services/superAdmin.js';

/**
 * Setting up on a machine with no terminal.
 *
 * `npm run seed` and `npm run bootstrap` assume somebody can type. A hosted
 * deployment has neither a keyboard nor a prompt, so the same two steps happen
 * here on first boot from environment variables, and never again: both are
 * guarded on there being nothing already, so a restart or a redeploy leaves a
 * running competition exactly as it was.
 */

async function ensureSeason() {
  if (get('SELECT 1 FROM seasons WHERE is_current = 1')) return;

  if (config.football.provider === 'football-data' && config.football.apiKey) {
    const provider = footballProvider();
    const season = await provider.season();
    const seeded = seedSeason({ seasonName: season.name, teams: season.teams, fixtures: false });
    await provider.refresh();
    console.log(`[boot] seeded ${seeded.seasonName} from football-data.org: ${seeded.teams} clubs.`);
    return;
  }
  const seeded = seedSeason();
  console.log(`[boot] seeded ${seeded.seasonName} with ${seeded.fixturesCreated} SAMPLE fixtures. `
    + 'Set FOOTBALL_PROVIDER=football-data and FOOTBALL_DATA_API_KEY for the real calendar.');
}

async function ensureSuperAdmin() {
  if (get('SELECT 1 FROM users WHERE is_super_admin = 1')) return;

  const email = String(process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.SUPERADMIN_PASSWORD || '');
  if (!email || !password) {
    console.warn('[boot] No super admin, and SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD are not set. '
      + 'Nobody can administer this deployment until they are.');
    return;
  }

  const strength = checkPasswordStrength(password, { superAdmin: true });
  if (!strength.ok) {
    console.error(`[boot] SUPERADMIN_PASSWORD ${strength.problems.join(', ')} — no account created.`);
    return;
  }

  const { totpSecret, codes } = await createOrResetSuperAdmin({
    email,
    name: process.env.SUPERADMIN_NAME || 'Super Admin',
    password,
  });

  // This is the only time these are ever shown. On a host that means the
  // deploy log, so say plainly that they need taking out of it.
  console.log(`\n${'='.repeat(60)}`);
  console.log(' SUPER ADMIN CREATED — copy this out of the log, then clear it');
  console.log('='.repeat(60));
  console.log(`  Sign in with: ${email}`);
  console.log(`  Two-factor secret: ${totpSecret}`);
  console.log(`  ${otpauthUrl({ secret: totpSecret, account: email })}`);
  console.log('  Recovery codes (once only):');
  for (const code of codes) console.log(`    ${code}`);
  console.log('\n  Then remove SUPERADMIN_PASSWORD from the environment: the account');
  console.log('  exists now, and the variable is only read when there is no admin.');
  console.log(`${'='.repeat(60)}\n`);
}

export async function autoSetup() {
  try {
    await ensureSeason();
    await ensureSuperAdmin();
  } catch (error) {
    // A failed setup must not stop the server: the operator needs the app up
    // to see what went wrong, and both steps retry on the next boot.
    console.error('[boot] automatic setup failed:', error.message);
  }
}
