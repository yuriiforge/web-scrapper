// Build step 2 acceptance checks, run against a real Postgres and an in-process mock-web.
import { checkpoints, items, rawResponses, runs, type DbHandle } from '@lp/db';
import { count, eq } from 'drizzle-orm';
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

async function itemCount(): Promise<number> {
  const [r] = await db.db.select({ n: count() }).from(items);
  return r!.n;
}

describe('a full run, then incremental runs', () => {
  let mock: MockWeb;
  let sourceId: string;
  const community = 'pl';

  beforeAll(async () => {
    await truncateAll(db);
    mock = await startMockWeb({ THREADIT_RATE: '100000' });
    sourceId = await createSource(db, { community, includeComments: true });
  });
  afterAll(async () => mock?.close());

  it('stores every post and comment in the community exactly once', async () => {
    const posts = mock.ctx.corpus.threadit.posts.filter((p) => p.community === community);
    const expected = new Set(posts.flatMap((p) => [p.id, ...p.comments.map((c) => c.id)]));

    const summary = await executeRun(executorDeps(db, mock), await createRun(db.db, sourceId, 'manual'));

    expect(summary).toMatchObject({ status: 'succeeded', itemsNew: expected.size, itemsFound: expected.size });
    const stored = await db.db.select({ id: items.externalId }).from(items);
    expect(stored).toHaveLength(expected.size);
    expect(new Set(stored.map((r) => r.id))).toEqual(expected);

    const [cp] = await db.db.select().from(checkpoints).where(eq(checkpoints.sourceId, sourceId));
    expect(cp?.cursor).toMatchObject({ id: posts[0]!.id });
  });

  it('adds zero items on a second run with nothing new, re-reading only the comment lookback window', async () => {
    const before = await itemCount();
    const requestsBefore = mock.ctx.state.requests.entries.length;
    const summary = await executeRun(executorDeps(db, mock), await createRun(db.db, sourceId, 'manual'));
    expect(summary).toMatchObject({ status: 'succeeded', itemsNew: 0 });
    expect(await itemCount()).toBe(before);
    // Listing pages only: every post's comment count matches what is stored, so no comment requests.
    const made = mock.ctx.state.requests.entries.slice(requestsBefore);
    expect(made.filter((e) => e.path.includes('/comments'))).toHaveLength(0);
    expect(summary.pages).toBeLessThanOrEqual(3);
  });

  it('collects new comments on posts it has already collected', async () => {
    const { ids } = (await mock.admin('POST', '/publish', { site: 'threadit', kind: 'comments', count: 6, community })) as { ids: string[] };
    const postsWithNew = new Set(
      mock.ctx.corpus.threadit.posts.filter((p) => p.comments.some((c) => ids.includes(c.id))).map((p) => p.id),
    );
    const requestsBefore = mock.ctx.state.requests.entries.length;
    const summary = await executeRun(executorDeps(db, mock), await createRun(db.db, sourceId, 'manual'));
    expect(summary).toMatchObject({ status: 'succeeded', itemsNew: ids.length });
    const stored = new Set((await db.db.select({ id: items.externalId }).from(items)).map((r) => r.id));
    for (const id of ids) expect(stored.has(id)).toBe(true);
    // Comments were fetched only for the posts that got new ones.
    const commentCalls = mock.ctx.state.requests.entries.slice(requestsBefore).filter((e) => e.path.includes('/comments'));
    expect(new Set(commentCalls.map((e) => /posts\/([^/]+)\/comments/.exec(e.path)![1]))).toEqual(postsWithNew);
  });

  it('picks up only posts published since the last run', async () => {
    const { ids } = (await mock.admin('POST', '/publish', { site: 'threadit', count: 60 })) as { ids: string[] };
    const newHere = ids.filter((id) => mock.ctx.corpus.threadit.posts.find((p) => p.id === id)?.community === community);
    expect(newHere.length).toBeGreaterThan(0);

    const before = await itemCount();
    const summary = await executeRun(executorDeps(db, mock), await createRun(db.db, sourceId, 'manual'));
    expect(summary).toMatchObject({ status: 'succeeded', itemsNew: newHere.length });
    expect(await itemCount()).toBe(before + newHere.length);
  });

  it('stores raw responses gzipped, and skips the body when a URL returns the same content', async () => {
    const raws = await db.db.select({ url: rawResponses.url, body: rawResponses.body }).from(rawResponses);
    expect(raws.length).toBeGreaterThan(10);
    expect(raws.some((r) => r.body === null)).toBe(true);
    expect(raws.find((r) => r.body !== null)!.body!.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  });
});

describe('rate limits and tokens', () => {
  beforeEach(async () => truncateAll(db));

  it('finishes without a failure when the site allows only 10 requests a minute', async () => {
    const mock = await startMockWeb({ THREADIT_RATE: '10' });
    try {
      // 12 listing pages against a limit of 10: the collector must wait for the window to reset.
      const sourceId = await createSource(db, { community: 'de', includeComments: false, pageSize: 20, maxPages: 12, ratePerMinute: 1000 });
      const summary = await executeRun(executorDeps(db, mock), await createRun(db.db, sourceId, 'manual'));
      expect(summary).toMatchObject({ status: 'succeeded', pages: 12, itemsNew: 240 });
      const limited = mock.ctx.state.requests.entries.filter((e) => e.site === 'threadit' && e.status === 429);
      expect(limited).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it('refreshes its token during a run longer than the token lifetime', async () => {
    const mock = await startMockWeb({ THREADIT_RATE: '100000', THREADIT_TOKEN_TTL: '2' });
    try {
      await mock.admin('PUT', '/chaos/threadit', { latencyMs: 300 });
      const sourceId = await createSource(db, { community: 'fr', includeComments: false, pageSize: 10, maxPages: 15 });
      const summary = await executeRun(executorDeps(db, mock), await createRun(db.db, sourceId, 'manual'));
      expect(summary).toMatchObject({ status: 'succeeded', pages: 15 });
      const tokenRequests = mock.ctx.state.requests.entries.filter((e) => e.path.includes('access_token'));
      expect(tokenRequests.length).toBeGreaterThan(1);
      expect(mock.ctx.state.requests.entries.filter((e) => e.status === 401)).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });
});

describe('failures', () => {
  beforeEach(async () => truncateAll(db));

  it('survives 30% server errors by retrying pages', async () => {
    const mock = await startMockWeb({ THREADIT_RATE: '100000' });
    try {
      await mock.admin('PUT', '/chaos/threadit', { errorRate: 0.3 });
      const sourceId = await createSource(db, { community: 'ua', includeComments: false });
      const expected = mock.ctx.corpus.threadit.posts.filter((p) => p.community === 'ua').length;
      const summary = await executeRun(executorDeps(db, mock), await createRun(db.db, sourceId, 'manual'));
      expect(summary).toMatchObject({ status: 'succeeded', itemsNew: expected });
      expect(mock.ctx.state.requests.entries.some((e) => e.status >= 500)).toBe(true);
    } finally {
      await mock.close();
    }
  });

  it('fails as a parse error when the layout changes, keeping the raw response and the old checkpoint', async () => {
    const mock = await startMockWeb({ THREADIT_RATE: '100000' });
    try {
      await mock.admin('PUT', '/chaos/threadit', { layoutVersion: 2 });
      const sourceId = await createSource(db, { community: 'us', includeComments: false });
      const runId = await createRun(db.db, sourceId, 'manual');
      const summary = await executeRun(executorDeps(db, mock), runId);
      expect(summary).toMatchObject({ status: 'failed', errorClass: 'parse', itemsNew: 0 });
      const [raw] = await db.db.select({ n: count() }).from(rawResponses).where(eq(rawResponses.runId, runId));
      expect(raw!.n).toBe(1);
      expect(await db.db.select().from(checkpoints)).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it('fails as bad_request without retrying when the community does not exist', async () => {
    const mock = await startMockWeb({ THREADIT_RATE: '100000' });
    try {
      const sourceId = await createSource(db, { community: 'nowhere' });
      const summary = await executeRun(executorDeps(db, mock), await createRun(db.db, sourceId, 'manual'));
      expect(summary).toMatchObject({ status: 'failed', errorClass: 'bad_request' });
      expect(mock.ctx.state.requests.entries.filter((e) => e.path.includes('/c/nowhere/'))).toHaveLength(1);
    } finally {
      await mock.close();
    }
  });

  it('stops promptly when cancelled mid-page, and a cancel is never overwritten', async () => {
    const mock = await startMockWeb({ THREADIT_RATE: '100000' });
    try {
      // 30 requests a minute with comments on: one page would take minutes.
      const sourceId = await createSource(db, { community: 'gb', includeComments: true, ratePerMinute: 30 });
      const runId = await createRun(db.db, sourceId, 'manual');
      const running = executeRun({ ...executorDeps(db, mock), cancelPollMs: 100 }, runId);
      await new Promise((r) => setTimeout(r, 1500));
      await db.db.update(runs).set({ status: 'cancelled' }).where(eq(runs.id, runId));
      const started = Date.now();
      const summary = await running;
      expect(Date.now() - started).toBeLessThan(2000);
      expect(summary.status).toBe('cancelled');
      const [row] = await db.db.select({ status: runs.status, finishedAt: runs.finishedAt }).from(runs).where(eq(runs.id, runId));
      expect(row).toMatchObject({ status: 'cancelled', finishedAt: expect.any(Date) });
    } finally {
      await mock.close();
    }
  });

  it('is a no-op when the same run is executed again (a retried job)', async () => {
    const mock = await startMockWeb({ THREADIT_RATE: '100000' });
    try {
      const sourceId = await createSource(db, { community: 'gb', includeComments: false, maxPages: 1 });
      const runId = await createRun(db.db, sourceId, 'manual');
      const first = await executeRun(executorDeps(db, mock), runId);
      const requests = mock.ctx.state.requests.entries.length;
      const second = await executeRun(executorDeps(db, mock), runId);
      expect(second).toEqual({ ...first, errorClass: null, errorMessage: null });
      expect(mock.ctx.state.requests.entries.length).toBe(requests);
    } finally {
      await mock.close();
    }
  });
});
