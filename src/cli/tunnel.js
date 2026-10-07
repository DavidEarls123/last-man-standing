import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { get } from '../db/index.js';
import { platformChecks } from '../services/readiness.js';

/**
 * A public address with nothing to install:  npm run tunnel
 *
 * localhost.run takes a plain SSH reverse tunnel and hands back an HTTPS
 * address pointing at this machine. Windows 10/11, macOS and Linux all ship an
 * ssh client, so unlike `npm run share` (which wants cloudflared) there is
 * nothing to download first.
 *
 * The trade is reliability: it is a free shared service, the address is random
 * and changes every run, and the session drops if the connection does. For an
 * afternoon of testing on a few machines that is fine. For a season, host it
 * properly.
 */

if (spawnSync('ssh', ['-V'], { encoding: 'utf8' }).error) {
  console.error('\nNo ssh client found, which is surprising — Windows 10/11, macOS and Linux all');
  console.error('ship one. On Windows: Settings → Apps → Optional features → OpenSSH Client.');
  console.error('Or use `npm run share`, which uses cloudflared instead.\n');
  process.exit(1);
}
if (!fs.existsSync(path.join(config.root, 'web', 'dist', 'index.html'))) {
  console.error('\nThe web app has not been built yet. Run `npm run build` first.\n');
  process.exit(1);
}
if (!get('SELECT 1 FROM seasons WHERE is_current = 1')) {
  console.error('\nNo fixtures loaded. Run `npm run seed` first.\n');
  process.exit(1);
}

console.log('\nOpening a public address (no account, nothing installed)…');

const tunnel = spawn('ssh', [
  // Its host key changes; this is a throwaway tunnel, not a server we trust.
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'ServerAliveInterval=30',
  '-R', `80:localhost:${config.port}`,
  'nokey@localhost.run',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let app = null;
let announced = false;

function start(publicUrl) {
  announced = true;
  app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: config.root,
    // Or every invite link points at localhost, which means "their computer".
    env: { ...process.env, PUBLIC_URL: publicUrl, PORT: String(config.port) },
    stdio: 'inherit',
  });
  app.on('exit', (code) => { tunnel.kill(); process.exit(code ?? 0); });

  setTimeout(() => {
    console.log(`\n${'─'.repeat(64)}`);
    console.log(`  Anyone can now reach this at:\n\n     ${publicUrl}\n`);
    const league = get("SELECT join_code, name FROM leagues WHERE launched_at IS NOT NULL ORDER BY id LIMIT 1");
    if (league) console.log(`  League "${league.name}" — join code ${league.join_code}`);

    if (config.email.provider === 'smtp' && config.email.smtpUrl) {
      console.log(`\n  Email is being sent for real, from ${config.email.from}.`);
    } else {
      console.log('\n  No mail server configured, so nothing is emailed. Everyone can read what');
      console.log('  they would have been sent under Messages, signed in as themselves.');
    }

    const blockers = platformChecks()
      .filter((check) => check.level === 'blocker'
        && !check.title.startsWith('PUBLIC_URL')
        && !check.title.startsWith('Email'));
    if (blockers.length) {
      console.log('\n  Still worth fixing:');
      for (const check of blockers) console.log(`    x ${check.title} — ${check.detail}`);
    }

    console.log('\n  The address dies when you press Ctrl-C, and is different next time.');
    console.log(`${'─'.repeat(64)}\n`);
  }, 1200);
}

const findUrl = (chunk) => String(chunk).match(/https:\/\/[-a-z0-9.]+\.lhr\.life/i)?.[0]
  ?? String(chunk).match(/https:\/\/[-a-z0-9.]+\.localhost\.run/i)?.[0];

for (const stream of [tunnel.stdout, tunnel.stderr]) {
  stream.on('data', (chunk) => {
    const url = !announced && findUrl(chunk);
    if (url) start(url);
    // localhost.run talks to you over stderr; worth seeing if it refuses.
    if (!announced) process.stderr.write(chunk);
  });
}

tunnel.on('exit', (code) => {
  if (!announced) console.error(`\nThe tunnel closed before giving us an address (exit ${code}).`);
  app?.kill();
  process.exit(code ?? 1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { app?.kill(); tunnel.kill(); process.exit(0); });
}
