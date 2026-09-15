import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { platformBranding } from './services/branding.js';
import { attachUser, requireSameOrigin } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { leaguesRouter } from './routes/leagues.js';
import { adminRouter } from './routes/admin.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'DENY');
    next();
  });

  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(attachUser);

  app.get('/api/health', (req, res) => res.json({ ok: true, provider: config.football.provider }));

  // Public: the sign-in screen needs the platform's name and mark before
  // anybody has signed in.
  app.get('/api/platform', (req, res) => res.json({ branding: platformBranding() }));

  app.use('/api', requireSameOrigin);
  app.use('/api/auth', authRouter);
  app.use('/api/leagues', leaguesRouter);
  app.use('/api/admin', adminRouter);

  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown endpoint' } }));

  // Built single-page app (npm run build), with a client-side routing fallback.
  const webDist = path.join(config.root, 'web', 'dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.get(/.*/, (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(webDist, 'index.html'));
    });
  } else {
    app.get('/', (req, res) => {
      res.type('text/plain').send(
        'API is running. Build the web app with `npm run build`, or run `npm run dev:web` for the Vite dev server.',
      );
    });
  }

  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
  app.use((error, req, res, next) => {
    const status = error.status ?? 500;
    if (status >= 500) console.error('[error]', error);
    res.status(status).json({
      error: {
        code: error.code ?? 'server_error',
        message: status >= 500 ? 'Something went wrong' : error.message,
        details: error.details,
      },
    });
  });

  return app;
}
