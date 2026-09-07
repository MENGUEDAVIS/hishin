import express from 'express';
import { logger } from '../observability/logger.js';
import { serverConfig } from './config.js';
import { apiRouter } from './routes.js';
import { resolve } from 'node:path';
import { requireAuth } from './auth.js';

if (process.env.NODE_ENV !== 'production' && !process.env.AUTH_MODE) process.env.AUTH_MODE = 'disabled';
if (process.env.NODE_ENV === 'production' && (process.env.AUTH_MODE !== 'alb' || !process.env.APP_ORIGIN || !process.env.ALB_ARN || !process.env.COGNITO_CLIENT_ID)) {
  throw new Error('Production authentication configuration is required');
}

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.get('/logged-out', (_req, res) => res.type('html').send('<!doctype html><html lang="fr"><meta charset="utf-8"><title>HI-SHIN — Connexion</title><body><h1>HI-SHIN</h1><p>Votre session est fermée.</p><a href="/">Se connecter ou créer un compte</a></body></html>'));
app.get('/logout', (_req, res) => {
  for (const suffix of ['', '-0', '-1', '-2', '-3']) res.clearCookie(`AWSELBAuthSessionCookie${suffix}`, { path: '/', secure: true, httpOnly: true });
  if (process.env.COGNITO_DOMAIN && process.env.COGNITO_CLIENT_ID && process.env.APP_ORIGIN) {
    const target = new URL('/logout', process.env.COGNITO_DOMAIN);
    target.searchParams.set('client_id', process.env.COGNITO_CLIENT_ID);
    target.searchParams.set('logout_uri', `${process.env.APP_ORIGIN}/logged-out`);
    res.redirect(target.toString());
  } else res.redirect('/logged-out');
});
app.use(express.json({ limit: '64kb' }));
app.use('/api', apiRouter);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint introuvable.' }));

// Public marketing page — the ALB's PublicPages rule exempts the exact "/"
// path from Cognito auth, so this must stay a single self-contained file
// (inline CSS/JS/images) with no separate asset requests, which would
// otherwise hit the auth-gated default rule and force a login redirect for
// a stylesheet.
app.get('/', (_req, res) => res.sendFile(resolve('ui/dist/landing.html')));

// The actual product lives under /app, which the ALB's default rule keeps
// behind Cognito auth (see infra/production.json). ui/vite.config.ts builds
// with base: '/app/' so its asset URLs already point here.
app.use('/app', requireAuth, express.static(resolve('ui/dist')));
app.get(/^\/app(\/.*)?$/, requireAuth, (_req, res) => res.sendFile(resolve('ui/dist/index.html')));
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err: error }, 'Request failed');
  res.status(400).json({ error: 'Requête refusée ou traitement impossible.' });
});

const server = app.listen(serverConfig.port, serverConfig.host, () => {
  logger.info({ host: serverConfig.host, port: serverConfig.port }, 'HI-SHIN server listening');
});

// Node's default requestTimeout (5 minutes) counts the whole request,
// including large multipart video uploads on a slow connection — past it,
// Node itself aborts the socket with a 408 before the upload route ever
// runs. Raised to cover MAX_UPLOAD_MB-sized uploads at realistic upload
// speeds; headersTimeout is left at its default since only the body is slow.
server.requestTimeout = 30 * 60 * 1000;
