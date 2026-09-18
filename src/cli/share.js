import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { get } from '../db/index.js';
import { platformChecks } from '../services/readiness.js';

/**
 * Put the app on a public HTTPS address for a while, free, with no account and
 * no card:  npm run share
 *
 * It runs a Cloudflare Quick Tunnel, which hands out a throwaway
 * *.trycloudflare.com address pointing at this machine. Good for letting a few
 * friends try it before you commit to a server. The address changes every time
 * and dies when you press Ctrl-C.
 */

const INSTALL = {
  darwin: 'brew install cloudflared',
  linux: 'sudo apt-get install -y cloudflared   # or see https://pkg.cloudflare.com',
  win32: 'winget install --id Cloudflare.cloudflared',
};

function cloudflaredMissing() {
  const probe = spawnSync('cloudflared', ['--version'], { encoding: 'utf8' });
  return Boolean(probe.error);
}

if (cloudflaredMissing()) {
  console.error('\ncloudflared is not installed. It is a single free binary from Cloudflare:\n');
  console.error(`  ${INSTALL[process.platform] ?? 'See https://pkg.cloudflare.com'}\n`);
  console.error('Then run `npm run share` again. No Cloudflare account is needed.\n');
  process.exit(1);
}

if (!fs.existsSync(path.join(config.root, 'web', 'dist', 'index.html'))) {
  console.error('\nThe web app has not been built yet. Run `npm run build` first.\n');
  process.exit(1);
}

if (!get('SELECT 1 FROM seasons WHERE is_current = 1')) {
  console.error('\nNo fixtures loaded. Run `npm run seed` (and `npm run demo` for players) first.\n');
  process.exit(1);
}

console.log('\nOpening a public address…');

const tunnel = spawn('cloudflared', [
  'tunnel', '--no-autoupdate', '--url', `http://localhost:${config.port}`,
], { stdio: ['ignore', 'pipe', 'pipe'] });

let app = null;
let announced = false;

function start(publicUrl) {
  announced = true;
  app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: config.root,
    // PUBLIC_URL has to match, or every invite link points at localhost.
    env: { ...process.env, PUBLIC_URL: publicUrl, PORT: String(config.port) },
    stdio: 'inherit',
  });
  app.on('exit', (code) => { tunnel.kill(); process.exit(code ?? 0); });

  const demo = get("SELECT join_code, name FROM leagues WHERE status IN ('open','active') ORDER BY id LIMIT 1");
  const player = get(
    `SELECT u.email FROM entries e JOIN users u ON u.id = e.user_id
     WHERE u.email LIKE '%@example.com' ORDER BY e.id LIMIT 1`,
  );

  setTimeout(() => {
    console.log(`\n${'─'.repeat(64)}`);
    console.log(`  Anyone can now reach this at:\n\n     ${publicUrl}\n`);
    if (demo) console.log(`  League "${demo.name}" — join code ${demo.join_code}`);
    if (player) console.log(`  Demo sign in: ${player.email} / demo-password-1234`);
    if (config.email.provider === 'smtp' && config.email.smtpUrl) {
      console.log(`\n  Email is being sent for real, from ${config.email.from}.`);
    } else {
      console.log('\n  Emails and texts are printed below instead of being sent, and are');
      console.log('  readable in the app under Platform → Notifications. Nobody else will');
      console.log('  receive an invite or a deadline reminder until you set EMAIL_PROVIDER=smtp.');
    }

    // PUBLIC_URL is ours now, so ignore the check that complains about it.
    const blockers = platformChecks()
      .filter((check) => check.level === 'blocker' && !check.title.startsWith('PUBLIC_URL'));
    if (blockers.length) {
      console.log('\n  Before real people use this:');
      for (const check of blockers) console.log(`    x ${check.title} — ${check.detail}`);
      console.log('  (`npm run checkup` explains each one.)');
    }

    console.log('\n  The address dies when you press Ctrl-C, and is different next time.');
    console.log(`${'─'.repeat(64)}\n`);
  }, 1200);
}

const findUrl = (chunk) => String(chunk).match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/i)?.[0];

for (const stream of [tunnel.stdout, tunnel.stderr]) {
  stream.on('data', (chunk) => {
    const url = !announced && findUrl(chunk);
    if (url) start(url);
  });
}

tunnel.on('exit', (code) => {
  if (!announced) console.error(`\ncloudflared stopped before giving us an address (exit ${code}).`);
  app?.kill();
  process.exit(code ?? 1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    app?.kill();
    tunnel.kill();
    process.exit(0);
  });
}
