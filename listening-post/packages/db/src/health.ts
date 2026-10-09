import { desc, sql } from 'drizzle-orm';
import type { Db } from './client';
import { workerHeartbeats } from './schema';

/** Round-trips a trivial query; throws if the database is unreachable. */
export async function pingDb(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}

/** Most recent heartbeat across all workers, or null if none has ever run. */
export async function latestHeartbeat(db: Db): Promise<{ workerId: string; lastSeen: Date } | null> {
  const [row] = await db
    .select({ workerId: workerHeartbeats.workerId, lastSeen: workerHeartbeats.lastSeen })
    .from(workerHeartbeats)
    .orderBy(desc(workerHeartbeats.lastSeen))
    .limit(1);
  return row ?? null;
}

export async function beat(db: Db, workerId: string, startedAt: Date): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({ workerId, startedAt, lastSeen: new Date() })
    .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: { lastSeen: new Date(), startedAt } });
}
