import { rawResponses, runs, sources, type Db } from '@lp/db';
import { QUEUES, RUN_TIMEOUT_SECONDS, type CollectJob, type PgBoss } from '@lp/queue';
import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import type { Logger } from 'pino';

/**
 * Makes pg-boss's schedules match the sources table: one cron schedule per enabled source
 * with a `schedule`, keyed by source id. Runs at start and every minute, so edits made
 * through the API take effect within a minute without the API talking to the worker.
 */
export async function syncSchedules(db: Db, boss: PgBoss, log: Logger): Promise<void> {
  const wanted = await db
    .select({ id: sources.id, schedule: sources.schedule })
    .from(sources)
    .where(and(eq(sources.enabled, true), isNotNull(sources.schedule)));
  const existing = new Map((await boss.getSchedules(QUEUES.collect)).map((s) => [s.key, s.cron]));

  for (const s of wanted) {
    if (existing.get(s.id) === s.schedule) continue;
    const job: CollectJob = { sourceId: s.id, trigger: 'schedule' };
    try {
      await boss.schedule(QUEUES.collect, s.schedule!, job, { key: s.id, singletonKey: s.id, tz: 'UTC' });
      log.info({ sourceId: s.id, cron: s.schedule }, 'schedule set');
    } catch (err) {
      log.warn({ err, sourceId: s.id, cron: s.schedule }, 'invalid schedule, skipped');
    }
  }
  const keep = new Set(wanted.map((s) => s.id));
  for (const key of existing.keys()) {
    if (!keep.has(key)) {
      await boss.unschedule(QUEUES.collect, key);
      log.info({ sourceId: key }, 'schedule removed');
    }
  }
}

/** Runs left `running` by a worker that died are marked failed, so they never look active forever. */
export async function failStaleRuns(db: Db, log: Logger): Promise<void> {
  const cutoff = new Date(Date.now() - (RUN_TIMEOUT_SECONDS + 60) * 1000);
  const stale = await db
    .update(runs)
    .set({ status: 'failed', errorClass: 'transient', errorMessage: 'worker stopped during the run', finishedAt: new Date() })
    .where(and(inArray(runs.status, ['running', 'queued']), lt(runs.createdAt, cutoff)))
    .returning({ id: runs.id });
  if (stale.length > 0) log.warn({ count: stale.length }, 'marked stale runs as failed');
}

/** Deletes raw responses past their retention date. Items keep a null raw_response_id. */
export async function deleteExpiredRaw(db: Db, log: Logger): Promise<void> {
  const deleted = await db.delete(rawResponses).where(lt(rawResponses.expiresAt, new Date())).returning({ id: rawResponses.id });
  if (deleted.length > 0) log.info({ count: deleted.length }, 'expired raw responses deleted');
}
