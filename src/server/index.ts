import express from 'express';
import { logger } from '../observability/logger.js';
import { serverConfig } from './config.js';
import { apiRouter } from './routes.js';
import { resolve } from 'node:path';

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
app.use(express.json({ limit: '64kb' }));
app.use('/api', apiRouter);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));

app.use(express.static(resolve('ui/dist')));
app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(resolve('ui/dist/index.html')));
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err: error }, 'Request failed');
  res.status(400).json({ error: 'Request rejected or could not be processed.' });
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
