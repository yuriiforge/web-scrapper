import { hostname } from 'node:os';
import { createClaudeClassifier, runAnalysis, type AnalysisDeps } from '@lp/analysis';
import { PgRateLimiter, createRun, executeReparse, executeRun, type ExecutorDeps } from '@lp/collectors';
import { beat, createDb } from '@lp/db';
import { QUEUES, startBoss, type CollectJob } from '@lp/queue';
import { loadEnv, workerEnv } from '@lp/shared';
import { pino } from 'pino';
import { startHeartbeat } from './heartbeat';
import { deleteExpiredRaw, failStaleRuns, syncSchedules } from './maintenance';
import { runMonitor, type MonitorDeps } from './monitor';

const env = loadEnv(workerEnv);
const workerId = `${hostname()}-${process.pid}`;
const log = pino({ level: env.LOG_LEVEL, base: { service: 'worker', workerId } });
const { db, close } = createDb(env.DATABASE_URL, { max: env.WORKER_CONCURRENCY + 4 });
const startedAt = new Date();

const stopHeartbeat = startHeartbeat({
  log,
  intervalMs: env.HEARTBEAT_INTERVAL_MS,
  beat: () => beat(db, workerId, startedAt),
  file: env.HEARTBEAT_FILE,
});

const executor: ExecutorDeps = {
  db,
  log,
  limiter: new PgRateLimiter(db),
  defaultRatePerMinute: env.DEFAULT_RATE_PER_MINUTE,
  rawRetentionDays: env.RAW_RETENTION_DAYS,
  collectorDeps: {
    baseUrl: env.SOURCE_BASE_URL,
    threadit: { clientId: env.THREADIT_CLIENT_ID, clientSecret: env.THREADIT_CLIENT_SECRET },
    passgate: { baseUrl: env.PASSGATE_URL ?? env.SOURCE_BASE_URL, key: env.PASSGATE_KEY, creditUsd: env.PASSGATE_CREDIT_USD },
    browser: { headless: env.BROWSER_HEADLESS, minuteUsd: env.BROWSER_MINUTE_USD },
    chirp: { key: env.CHIRP_KEY, postUsd: env.CHIRP_POST_USD },
  },
};

const boss = await startBoss(env.DATABASE_URL, { role: 'worker', onError: (err) => log.error({ err }, 'queue error') });

await boss.work<CollectJob>(QUEUES.collect, { localConcurrency: env.WORKER_CONCURRENCY, batchSize: 1 }, async (jobs) => {
  for (const job of jobs) {
    // Scheduled jobs carry only the source; manual ones arrive with the run the API created.
    const runId = job.data.runId ?? (await createRun(db, job.data.sourceId, job.data.trigger));
    // A failed run is recorded on the run row; the job itself completes, so pg-boss does not retry it.
    if (job.data.trigger === 'reparse') await executeReparse(executor, runId);
    else await executeRun(executor, runId, job.signal);
  }
});

const monitor: MonitorDeps = {
  db,
  log: log.child({ job: 'monitor' }),
  cronIntervalMs: (cron) => {
    try {
      const [a, b] = boss.previewSchedule(cron, { count: 2, tz: 'UTC' });
      return a && b ? b.getTime() - a.getTime() : null;
    } catch {
      return null;
    }
  },
  hosts: [env.SOURCE_BASE_URL],
  webhookUrl: env.ALERT_WEBHOOK_URL,
};
// Every minute, as a job on an exclusive queue: one pass at a time, whatever the number of workers.
await boss.schedule(QUEUES.monitor, '* * * * *', {}, { key: 'monitor', tz: 'UTC' });
await boss.work(QUEUES.monitor, async () => {
  await runMonitor(monitor);
});

const analysis: AnalysisDeps = {
  db,
  log: log.child({ job: 'analyze' }),
  llm: env.ANTHROPIC_API_KEY
    ? {
        classifier: createClaudeClassifier({ model: env.LLM_MODEL }),
        maxItemsPerPass: env.LLM_MAX_ITEMS_PER_PASS,
        batchSize: env.LLM_BATCH_SIZE,
        monthlyUsd: env.LLM_MONTHLY_USD,
        inputUsdPerMTok: env.LLM_INPUT_USD_PER_MTOK,
        outputUsdPerMTok: env.LLM_OUTPUT_USD_PER_MTOK,
      }
    : undefined,
};
await boss.schedule(QUEUES.analyze, '* * * * *', {}, { key: 'analyze', tz: 'UTC' });
await boss.work(QUEUES.analyze, async () => {
  await runAnalysis(analysis);
});

const every = (ms: number, task: () => Promise<void>, name: string) => {
  const run = () => task().catch((err: unknown) => log.error({ err }, `${name} failed`));
  void run();
  return setInterval(run, ms);
};
const timers = [
  every(60_000, () => syncSchedules(db, boss, log), 'schedule sync'),
  every(5 * 60_000, () => failStaleRuns(db, log), 'stale run sweep'),
  every(60 * 60_000, () => deleteExpiredRaw(db, log), 'raw retention'),
];

log.info(
  { sourceBaseUrl: env.SOURCE_BASE_URL, concurrency: env.WORKER_CONCURRENCY, llmModel: analysis.llm ? env.LLM_MODEL : null },
  'worker started',
);

const shutdown = (signal: string) => {
  log.info({ signal }, 'shutting down');
  timers.forEach(clearInterval);
  stopHeartbeat();
  // Finish in-flight jobs for up to 20 s, then close the pool.
  void boss
    .stop({ graceful: true, timeout: 20_000 })
    .catch((err: unknown) => log.error({ err }, 'queue stop failed'))
    .finally(() => void close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 25_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
