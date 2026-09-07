import express from 'express';
import { logger } from '../observability/logger.js';
import { serverConfig } from './config.js';
import { apiRouter } from './routes.js';

const app = express();
app.use(express.json());
app.use('/api', apiRouter);

app.get('/', (_req, res) => {
  res.type('text').send('HI-SHIN API is running. The dev UI lives in ui/ (npm run dev there), proxying /api here.');
});

app.listen(serverConfig.port, serverConfig.host, () => {
  logger.info({ host: serverConfig.host, port: serverConfig.port }, 'HI-SHIN server listening');
});
