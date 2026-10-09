import { PgBoss } from 'pg-boss';

/** Queue names. One place, so the API (producer) and the worker (consumer) cannot drift apart. */
export const QUEUES = {
  /** One job = one collection run of one source. */
  collect: 'collect',
} as const;

/**
 * A collection job. Manual runs carry the `runId` the API already created; scheduled runs carry
 * only `sourceId` and the worker creates the run row itself.
 */
export interface CollectJob {
  sourceId: string;
  runId?: string;
  trigger: 'manual' | 'schedule' | 'reparse';
}

/** Hard limit for one run; pg-boss expires the job (and retries once) if a worker dies mid-run. */
export const RUN_TIMEOUT_SECONDS = 30 * 60;

export interface BossOptions {
  /** Producers (the API) only send jobs; the worker also runs maintenance and the cron scheduler. */
  role: 'producer' | 'worker';
  onError?: (err: Error) => void;
}

export async function startBoss(url: string, opts: BossOptions): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: url,
    schema: 'pgboss',
    supervise: opts.role === 'worker',
    schedule: opts.role === 'worker',
  });
  boss.on('error', (err: Error) => opts.onError?.(err));
  await boss.start();
  await ensureQueues(boss);
  return boss;
}

async function ensureQueues(boss: PgBoss): Promise<void> {
  if (!(await boss.getQueue(QUEUES.collect))) {
    await boss.createQueue(QUEUES.collect, {
      // At most one active job per singletonKey (= source id): one run per source at a time.
      policy: 'singleton',
      expireInSeconds: RUN_TIMEOUT_SECONDS,
      // Page-level retries happen inside the run; this only covers a worker crashing mid-run.
      retryLimit: 1,
      retryDelay: 30,
    });
  }
}

/** Queues a collection run. One per source at a time; extra jobs wait their turn. */
export async function sendCollect(boss: PgBoss, job: CollectJob): Promise<string | null> {
  return boss.send(QUEUES.collect, job, { singletonKey: job.sourceId });
}

export type { PgBoss };
