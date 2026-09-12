import { createApp } from './app.js';
import { config } from './config.js';
import { startScheduler } from './scheduler.js';
import { get } from './db/index.js';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`Last Man Standing listening on ${config.publicUrl} (port ${config.port})`);
  console.log(`Football data provider: ${config.football.provider}${config.football.simulate ? ' (simulated live scores)' : ''}`);
  if (!get('SELECT 1 FROM users WHERE is_super_admin = 1')) {
    console.warn('No super admin exists yet — run `npm run bootstrap` to create one.');
  }
  if (!get('SELECT 1 FROM seasons WHERE is_current = 1')) {
    console.warn('No season loaded — run `npm run seed` to load fixtures.');
  }
});

const stopScheduler = startScheduler();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopScheduler();
    server.close(() => process.exit(0));
  });
}
