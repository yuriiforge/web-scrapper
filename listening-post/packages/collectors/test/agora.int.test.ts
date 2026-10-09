// Build step 3 acceptance checks for the Agora collector, against a real Postgres and an in-process mock-web.
import { items, rawResponses, type DbHandle } from '@lp/db';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgoraCollector } from '../src/agora/collector';
import { parseListingHtml, parseListingJson } from '../src/agora/parse';
import { normalizeText } from '../src/normalize';
import { createRun, executeRun } from '../src/run';
import type { RawResponse } from '../src/types';
import { createSource, executorDeps, freshDatabase, requestStats, startMockWeb, truncateAll, type MockWeb } from './harness';

let db: DbHandle;

beforeAll(async () => {
  db = await freshDatabase();
});
afterAll(async () => {
  await db?.close();
});

const get = async (url: string): Promise<RawResponse> => {
  const res = await fetch(url);
  return { url, status: res.status, headers: {}, body: await res.text(), fetchedAt: new Date() };
};

/** The topics a run with `maxTopics` should collect: the most recently active ones in the category. */
function expectedPosts(mock: MockWeb, category: string, maxTopics: number): Set<string> {
  const topics = mock.ctx.corpus.agora.topics
    .filter((t) => t.category === category)
    .sort((a, b) => b.lastPosted - a.lastPosted || (a.id < b.id ? 1 : -1))
    .slice(0, maxTopics);
  return new Set(topics.flatMap((t) => t.posts.map((p) => p.id)));
}

async function storedIds(): Promise<Set<string>> {
  return new Set((await db.db.select({ id: items.externalId }).from(items)).map((r) => r.id));
}

describe('HTML and JSON parsers', () => {
  let mock: MockWeb;
  beforeAll(async () => {
    mock = await startMockWeb({ AGORA_RATE: '1000' });
  });
  afterAll(async () => mock?.close());

  it('read the same topics from a listing page', async () => {
    const html = parseListingHtml(await get(`${mock.url}/agora/c/meal-kits?page=2`));
    const json = parseListingJson(await get(`${mock.url}/agora/c/meal-kits.json?page=2`));
    expect(html.topics).toHaveLength(30);
    expect(html).toEqual(json);
  });

  it('produce identical items for the same topics, including multi-page ones', async () => {
    const collector = new AgoraCollector({ format: 'json' }, { baseUrl: mock.url, threadit: { clientId: '', clientSecret: '' } });
    const listing = parseListingJson(await get(`${mock.url}/agora/latest.json?page=1`));
    let compared = 0;
    for (const topic of listing.topics) {
      for (let page = 1; page <= Math.ceil(topic.postsCount / 20); page++) {
        const fromHtml = collector.parse(await get(`${mock.url}/agora/t/${topic.id}?page=${page}`));
        const fromJson = collector.parse(await get(`${mock.url}/agora/t/${topic.id}.json?page=${page}`));
        // Markup may serialise entities differently; what is stored is the normalised text.
        const stored = (xs: typeof fromHtml) => xs.map((x) => ({ ...x, text: normalizeText(x.text) }));
        expect(stored(fromHtml)).toEqual(stored(fromJson));
        compared += fromJson.length;
      }
    }
    expect(compared).toBeGreaterThan(300);
  });
});

describe('a JSON run, then incremental runs', () => {
  let mock: MockWeb;
  let sourceId: string;
  let firstRunStarted: number;

  beforeAll(async () => {
    await truncateAll(db);
    mock = await startMockWeb();
    sourceId = await createSource(db, { category: 'meal-kits', format: 'json', maxTopics: 6 }, 'agora meal-kits', 'agora');
  });
  afterAll(async () => mock?.close());

  it('collects the most recently active topics, at most one request a second, never touching /agora/admin/', async () => {
    const expected = expectedPosts(mock, 'meal-kits', 6);
    firstRunStarted = Date.now();
    const summary = await executeRun(executorDeps(db, mock), await createRun(db.db, sourceId, 'manual'));

    expect(summary).toMatchObject({ status: 'succeeded', itemsNew: expected.size });
    expect(await storedIds()).toEqual(expected);

    const stats = await requestStats(mock, 'agora', firstRunStarted);
    expect(stats.peak_rps).toBeLessThanOrEqual(1);
    expect(stats.entries.some((e) => e.path.startsWith('/agora/admin'))).toBe(false);
    expect(stats.entries[0]!.path).toBe('/agora/robots.txt');
  });

  it('gets mostly 304s on a rerun with no new posts, and adds nothing', async () => {
    const since = Date.now();
    const summary = await executeRun(executorDeps(db, mock), await createRun(db.db, sourceId, 'manual'));
    expect(summary).toMatchObject({ status: 'succeeded', itemsNew: 0 });

    const stats = await requestStats(mock, 'agora', since);
    const notModified = stats.counts.agora?.['304'] ?? 0;
    expect(stats.total).toBeGreaterThan(0);
    expect(notModified / stats.total).toBeGreaterThanOrEqual(0.5);
  });

  it('fetches only topics with new posts after some are published', async () => {
    const { ids } = (await mock.admin('POST', '/publish', { site: 'agora', count: 3, topic: 'meal kits' })) as { ids: string[] };
    // The new posts may land in topics the capped first run never collected; those come in whole.
    const changedTopics = mock.ctx.corpus.agora.topics.filter((t) => t.posts.some((p) => ids.includes(p.id)));
    const before = await storedIds();
    const expectedNew = new Set(changedTopics.flatMap((t) => t.posts.map((p) => p.id)).filter((id) => !before.has(id)));

    const since = Date.now();
    const summary = await executeRun(executorDeps(db, mock), await createRun(db.db, sourceId, 'manual'));
    expect(summary).toMatchObject({ status: 'succeeded', itemsNew: expectedNew.size });
    const stored = await storedIds();
    for (const id of ids) expect(stored.has(id)).toBe(true);
    expect([...stored].filter((id) => !before.has(id)).sort()).toEqual([...expectedNew].sort());

    const stats = await requestStats(mock, 'agora', since);
    // robots.txt (304) + one listing page + the pages of at most 3 changed topics, not the whole category.
    expect(stats.total).toBeLessThan(15);
    expect(stats.peak_rps).toBeLessThanOrEqual(1);
  });
});

describe('HTML mode and failures', () => {
  it('collects the same posts by parsing HTML pages', async () => {
    await truncateAll(db);
    const mock = await startMockWeb();
    try {
      const expected = expectedPosts(mock, 'fitness-trackers', 4);
      const sourceId = await createSource(db, { category: 'fitness-trackers', format: 'html', maxTopics: 4 }, 'agora html', 'agora');
      const summary = await executeRun(executorDeps(db, mock), await createRun(db.db, sourceId, 'manual'));
      expect(summary).toMatchObject({ status: 'succeeded', itemsNew: expected.size });
      expect(await storedIds()).toEqual(expected);
    } finally {
      await mock.close();
    }
  });

  it.each(['html', 'json'] as const)('fails as a parse error after a layout change (%s), keeping the response', async (format) => {
    await truncateAll(db);
    const mock = await startMockWeb();
    try {
      await mock.admin('PUT', '/chaos/agora', { layoutVersion: 2 });
      const sourceId = await createSource(db, { category: 'online-banks', format, maxTopics: 2 }, `agora v2 ${format}`, 'agora');
      const runId = await createRun(db.db, sourceId, 'manual');
      const summary = await executeRun(executorDeps(db, mock), runId);
      expect(summary).toMatchObject({ status: 'failed', errorClass: 'parse', itemsNew: 0 });
      expect(summary.errorMessage).toMatch(format === 'html' ? /post-body/ : /cooked/);
      const [raw] = await db.db.select({ n: count() }).from(rawResponses).where(eq(rawResponses.runId, runId));
      expect(raw!.n).toBeGreaterThanOrEqual(1);
    } finally {
      await mock.close();
    }
  });
});
