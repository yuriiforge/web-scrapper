import { hostname } from 'node:os';
import { beat, createDb } from '@lp/db';
import { loadEnv, workerEnv } from '@lp/shared';
import { pino } from 'pino';
import { startHeartbeat } from './heartbeat';

const env = loadEnv(workerEnv);
const workerId = `${hostname()}-${process.pid}`;
const log = pino({ level: env.LOG_LEVEL, base: { service: 'worker', workerId } });
const { db, close } = createDb(env.DATABASE_URL, { max: 5 });
const startedAt = new Date();

const stopHeartbeat = startHeartbeat({
  log,
  intervalMs: env.HEARTBEAT_INTERVAL_MS,
  beat: () => beat(db, workerId, startedAt),
  file: env.HEARTBEAT_FILE,
});

// Job consumers (pg-boss queues for collect, parse, score, monitor) are added from build step 2.
log.info({ sourceBaseUrl: env.SOURCE_BASE_URL }, 'worker started');

const shutdown = (signal: string) => {
  log.info({ signal }, 'shutting down');
  stopHeartbeat();
  void close().finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
