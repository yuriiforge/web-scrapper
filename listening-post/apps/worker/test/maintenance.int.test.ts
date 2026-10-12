// The stale-run sweep against a real database and a real pg-boss queue.
import { clients, runs, sources, type DbHandle } from '@lp/db';
import { sendCollect, startBoss, type PgBoss } from '@lp/queue';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL, freshDatabase } from '../../../packages/collectors/test/harness';
import { failStaleRuns } from '../src/maintenance';

let db: DbHandle;
let boss: PgBoss;
let sourceId: string;
const log = pino({ level: 'silent' });
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

beforeAll(async () => {
  db = await freshDatabase();
  boss = await startBoss(TEST_DATABASE_URL, { role: 'producer' });
  const [client] = await db.db.insert(clients).values({ name: 'c' }).returning();
  const [source] = await db.db
    .insert(sources)
    .values({ clientId: client!.id, name: 's', site: 'threadit', strategy: 'api', config: { community: 'gb' } })
    .returning();
  sourceId = source!.id;
});

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await db?.close();
});

async function addRun(values: Partial<typeof runs.$inferInsert>): Promise<string> {
  const [r] = await db.db.insert(runs).values({ sourceId, trigger: 'manual', ...values }).returning({ id: runs.id });
  return r!.id;
}

const statusOf = async (id: string) => (await db.db.select({ s: runs.status }).from(runs).where(eq(runs.id, id)))[0]!.s;

describe('failStaleRuns', () => {
  it('fails only runs that can never finish', async () => {
    const deadWorker = await addRun({ status: 'running', startedAt: minutesAgo(40), createdAt: minutesAgo(41) });
    const longButAlive = await addRun({ status: 'running', startedAt: minutesAgo(5), createdAt: minutesAgo(90) });
    const waitingWithJob = await addRun({ status: 'queued', createdAt: minutesAgo(45) });
    await sendCollect(boss, { sourceId, runId: waitingWithJob, trigger: 'manual' });
    const lostJob = await addRun({ status: 'queued', createdAt: minutesAgo(45) });
    const justCreated = await addRun({ status: 'queued', createdAt: minutesAgo(2) });

    await failStaleRuns(db.db, log);

    expect(await statusOf(deadWorker)).toBe('failed');
    expect(await statusOf(longButAlive)).toBe('running');
    expect(await statusOf(waitingWithJob)).toBe('queued');
    expect(await statusOf(lostJob)).toBe('failed');
    expect(await statusOf(justCreated)).toBe('queued');
  });
});
