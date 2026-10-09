import { createDb, latestHeartbeat, pingDb } from '@lp/db';
import { apiEnv, loadEnv } from '@lp/shared';
import { pino } from 'pino';
import { createApp } from './app';

const env = loadEnv(apiEnv);
const log = pino({ level: env.LOG_LEVEL, base: { service: 'api' } });
const { db, close } = createDb(env.DATABASE_URL);

const app = createApp({
  log,
  health: { pingDb: () => pingDb(db), latestHeartbeat: () => latestHeartbeat(db) },
});

const server = app.listen(env.API_PORT, () => log.info({ port: env.API_PORT }, 'api listening'));

const shutdown = (signal: string) => {
  log.info({ signal }, 'shutting down');
  server.close(() => {
    void close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
