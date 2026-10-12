// Build step 5 acceptance checks for the Chirp collector: a paid, metered API, against a real
// Postgres and an in-process mock-web.
import { checkpoints, costs, items, sources, type DbHandle } from '@lp/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRun, executeRun } from '../src/run';
import { createSource, executorDeps, freshDatabase, startMockWeb, truncateAll, type MockWeb } from './harness';

let db: DbHandle;

beforeAll(async () => {
  db = await freshDatabase();
});
afterAll(async () => {
  await db?.close();
});

const chirpSource = (config: Record<string, unknown>, name = 'chirp source') =>
  createSource(db, { backfillDays: 365, ...config }, name, 'chirp');

const run = async (mock: MockWeb, sourceId: string) => executeRun(executorDeps(db, mock), await createRun(db.db, sourceId, 'manual'));

function matching(mock: MockWeb, query: string, country?: string): Set<string> {
  return new Set(
    mock.ctx.corpus.chirp.posts.filter((p) => p.text.toLowerCase().includes(query) && (!country || p.country === country)).map((p) => p.id),
  );
}

async function storedIds(): Promise<Set<string>> {
  return new Set((await db.db.select({ id: items.externalId }).from(items).where(eq(items.site, 'chirp'))).map((r) => r.id));
}

async function creditsUsed(mock: MockWeb): Promise<number> {
  const res = await fetch(`${mock.url}/chirp/v2/usage`, { headers: { authorization: 'Bearer chirp-dev-key' } });
  return ((await res.json()) as { credits_used: number }).credits_used;
}

async function ledgerPosts(sourceId: string): Promise<number> {
  const [r] = await db.db
    .select({ n: sql<number>`coalesce(sum(${costs.units}), 0)`.mapWith(Number) })
    .from(costs)
    .where(eq(costs.sourceId, sourceId));
  return r!.n;
}

describe('paying once per post', () => {
  let mock: MockWeb;
  let sourceId: string;

  beforeAll(async () => {
    await truncateAll(db);
    mock = await startMockWeb({ CHIRP_RATE: '100000' });
    sourceId = await chirpSource({ query: 'delivery', country: 'GB' });
  });
  afterAll(async () => mock?.close());

  it('collects every matching post, and the ledger matches what Chirp charged', async () => {
    const expected = matching(mock, 'delivery', 'GB');
    const summary = await run(mock, sourceId);
    expect(summary).toMatchObject({ status: 'succeeded', itemsNew: expected.size });
    expect(await storedIds()).toEqual(expected);
    expect(await ledgerPosts(sourceId)).toBe(await creditsUsed(mock));
    expect(await creditsUsed(mock)).toBe(expected.size);
  });

  it('does not pay again for posts already stored', async () => {
    const before = await creditsUsed(mock);
    const summary = await run(mock, sourceId);
    expect(summary).toMatchObject({ status: 'succeeded', itemsNew: 0 });
    // One search that finds nothing new still costs Chirp's minimum of one credit.
    expect((await creditsUsed(mock)) - before).toBeLessThanOrEqual(1);
  });

  it('pays only for the new posts after more are published', async () => {
    await mock.admin('POST', '/publish', { site: 'chirp', count: 200 });
    const stored = await storedIds();
    const fresh = [...matching(mock, 'delivery', 'GB')].filter((id) => !stored.has(id));
    const before = await creditsUsed(mock);
    const summary = await run(mock, sourceId);
    expect(summary).toMatchObject({ status: 'succeeded', itemsNew: fresh.length });
    expect((await creditsUsed(mock)) - before).toBe(Math.max(1, fresh.length));
  });
});

describe('running out', () => {
  beforeEach(async () => truncateAll(db));

  it('with a balance of 30, stores 30 posts and ends partial; after a top-up it continues without paying twice', async () => {
    const mock = await startMockWeb({ CHIRP_RATE: '100000' });
    try {
      await mock.admin('POST', '/credits', { site: 'chirp', balance: 30 });
      const sourceId = await chirpSource({ query: 'airline', maxPostsPerRun: 100 });
      const first = await run(mock, sourceId);
      expect(first).toMatchObject({ status: 'partial', errorClass: 'quota', itemsNew: 30 });
      const [cp] = await db.db.select({ cursor: checkpoints.cursor }).from(checkpoints);
      expect((cp!.cursor as { gaps: unknown[] }).gaps).toHaveLength(1);

      await mock.admin('POST', '/credits', { site: 'chirp', balance: 1000 });
      const before = await creditsUsed(mock);
      const second = await run(mock, sourceId);
      expect(second.status).toBe('succeeded');
      const paid = (await creditsUsed(mock)) - before;
      // The new-posts window finds nothing (1 credit, Chirp's minimum), then the gap below the first
      // 30 posts fills the rest of the 100-post cap: 99 posts, every one of them new.
      expect(paid).toBe(100);
      expect(second.itemsNew).toBe(99);
      expect((await storedIds()).size).toBe(30 + 99);
    } finally {
      await mock.close();
    }
  });

  it("stops at the source's monthly budget without overspending", async () => {
    const mock = await startMockWeb({ CHIRP_RATE: '100000' });
    try {
      const sourceId = await chirpSource({ query: 'airline' }, 'budgeted');
      // $0.01 at $0.0005 a post: 20 posts.
      await db.db.update(sources).set({ budgetUsdMonth: 0.01 }).where(eq(sources.id, sourceId));
      const summary = await run(mock, sourceId);
      expect(summary).toMatchObject({ status: 'partial', errorClass: 'quota', itemsNew: 20 });
      expect(summary.errorMessage).toMatch(/budget/);
      expect(await ledgerPosts(sourceId)).toBe(20);
    } finally {
      await mock.close();
    }
  });

  it('fails as a parse error when the response layout changes', async () => {
    const mock = await startMockWeb({ CHIRP_RATE: '100000' });
    try {
      await mock.admin('PUT', '/chaos/chirp', { layoutVersion: 2 });
      const sourceId = await chirpSource({ query: 'airline' }, 'layout v2');
      const summary = await run(mock, sourceId);
      expect(summary).toMatchObject({ status: 'failed', errorClass: 'parse' });
    } finally {
      await mock.close();
    }
  });
});
