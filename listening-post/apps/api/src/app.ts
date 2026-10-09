import express, { type ErrorRequestHandler, type Express } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { checkHealth, type HealthDeps } from './health';

export interface AppDeps {
  log: Logger;
  health: HealthDeps;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(pinoHttp({ logger: deps.log, autoLogging: { ignore: (req) => req.url === '/health' } }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', async (_req, res) => {
    const report = await checkHealth(deps.health);
    res.status(report.status === 'down' ? 503 : 200).json(report);
  });

  // Routes for sources, runs, items and costs are added from build step 2 onwards.

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    req.log.error({ err }, 'unhandled error');
    if (!res.headersSent) res.status(500).json({ error: 'internal' });
  };
  app.use(onError);
  return app;
}
