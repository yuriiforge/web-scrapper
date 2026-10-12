// Build step 4 acceptance checks for the Ratewell collector: plain HTTP, Playwright, and escalation
// to PassGate, against a real Postgres and an in-process mock-web.
import { checkpoints, costs, items, runs, sources, type DbHandle } from '@lp/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { normalizeText } from '../src/normalize';
import { parseRenderedHtml, parseReviewsJson, reviewToItem } from '../src/ratewell/parse';
import { createRun, executeRun } from '../src/run';
import { createSource, executorDeps, freshDatabase, startMockWeb, truncateAll, type MockWeb } from './harness';

const COMPANY = 'voltra-motors';
let db: DbHandle;

beforeAll(async () => {
  db = await freshDatabase();
});
afterAll(async () => {
  await db?.close();
});

const ratewellSource = (config: Record<string, unknown> = {}, name = 'ratewell source') =>
  createSource(db, { company: COMPANY, ...config }, name, 'ratewell');

const run = async (mock: MockWeb, sourceId: string) => executeRun(executorDeps(db, mock), await createRun(db.db, sourceId, 'manual'));

async function storedReviewIds(): Promise<Set<string>> {
  return new Set((await db.db.select({ id: items.externalId }).from(items).where(eq(items.site, 'ratewell'))).map((r) => r.id));
}

async function costRows(sourceId: string) {
  return db.db.select({ provider: costs.provider, units: costs.units, usd: costs.usd }).from(costs).where(eq(costs.sourceId, sourceId));
}

async function passgateUsage(mock: MockWeb) {
  const res = await fetch(`${mock.url}/passgate/v1/usage`, { headers: { authorization: 'Bearer pg-dev-key' } });
  return (await res.json()) as { credits_remaining: number; credits_used: number; requests: number };
}

function expectedReviews(mock: MockWeb): Set<string> {
  return new Set(mock.ctx.corpus.ratewell.companies.find((c) => c.slug === COMPANY)!.reviews.map((r) => r.id));
}

describe('collecting without being blocked', () => {
  let mock: MockWeb;
  beforeAll(async () => {
    mock = await startMockWeb();
  });
  afterAll(async () => mock?.close());
  beforeEach(async () => truncateAll(db));

  it('gets all 150 reviews over plain HTTP at bot-check level 1, for free', async () => {
    const sourceId = await ratewellSource();
    const summary = await run(mock, sourceId);
    expect(summary).toMatchObject({ status: 'succeeded', itemsNew: 150, pages: 8 });
    expect(await storedReviewIds()).toEqual(expectedReviews(mock));
    expect(await costRows(sourceId)).toEqual([]);
    const [r] = await db.db.select({ strategy: runs.strategy }).from(runs).where(eq(runs.id, summary.runId));
    expect(r!.strategy).toBe('html');

    const [one] = await db.db.select({ meta: items.meta, text: items.text, country: items.country }).from(items).limit(1);
    expect(one!.meta).toMatchObject({ rating: expect.any(Number), verified: expect.any(Boolean) });
    expect(one!.country).toMatch(/^[A-Z]{2}$/);
  });

  it.each([1, 2])('gets all 150 reviews with the browser at bot-check level %i, and records browser time', async (level) => {
    await mock.admin('PUT', '/chaos/ratewell', { botCheckLevel: level });
    const sourceId = await ratewellSource({ strategies: ['browser'] }, `browser level ${level}`);
    const summary = await run(mock, sourceId);
    expect(summary).toMatchObject({ status: 'succeeded', itemsNew: 150, pages: 8 });
    expect(await storedReviewIds()).toEqual(expectedReviews(mock));
    const charged = await costRows(sourceId);
    expect(charged).toHaveLength(1);
    expect(charged[0]).toMatchObject({ provider: 'browser' });
    expect(charged[0]!.units).toBeGreaterThan(0);
  }, 120_000);

  it('is blocked at level 2 when the same browser leaves navigator.webdriver visible (control)', async () => {
    // Proves that hiding webdriver is what gets the browser past level 2, not luck.
    await mock.admin('PUT', '/chaos/ratewell', { botCheckLevel: 2 });
    try {
      const sourceId = await ratewellSource({ strategies: ['browser'] }, 'visible webdriver');
      const deps = executorDeps(db, mock);
      deps.collectorDeps.browser = { headless: true, minuteUsd: 0.01, hideWebdriver: false };
      const summary = await executeRun(deps, await createRun(db.db, sourceId, 'manual'));
      expect(summary).toMatchObject({ status: 'failed', errorClass: 'blocked', itemsNew: 0 });
      expect(summary.errorMessage).toMatch(/reason: webdriver/);
    } finally {
      await mock.admin('PUT', '/chaos/ratewell', { botCheckLevel: 1 });
    }
  }, 120_000);
});

describe('escalation to PassGate', () => {
  let mock: MockWeb;
  beforeAll(async () => {
    await truncateAll(db);
    mock = await startMockWeb();
    await mock.admin('PUT', '/chaos/ratewell', { botCheckLevel: 3 });
  });
  afterAll(async () => mock?.close());

  let sourceId: string;

  it('climbs html → browser → unblocker at level 3 and still gets all 150 reviews', async () => {
    sourceId = await ratewellSource({}, 'escalating source');
    const summary = await run(mock, sourceId);
    expect(summary).toMatchObject({ status: 'succeeded', itemsNew: 150 });
    expect(await storedReviewIds()).toEqual(expectedReviews(mock));

    const [r] = await db.db.select({ strategy: runs.strategy }).from(runs).where(eq(runs.id, summary.runId));
    expect(r!.strategy).toBe('unblocker');
    const [cp] = await db.db.select({ cursor: checkpoints.cursor, step: checkpoints.escalationStep }).from(checkpoints);
    expect(cp).toMatchObject({ step: 'unblocker', cursor: { step: 'unblocker' } });
  }, 120_000);

  it('records exactly the PassGate credits used in the cost ledger', async () => {
    const usage = await passgateUsage(mock);
    const passgate = (await costRows(sourceId)).filter((c) => c.provider === 'passgate');
    const credits = passgate.reduce((n, c) => n + c.units, 0);
    expect(credits).toBe(usage.credits_used);
    // The raw JSON route: one credit per page of 20 reviews.
    expect(credits).toBe(8);
    expect(passgate.reduce((n, c) => n + c.usd, 0)).toBeCloseTo(8 * 0.002, 6);
  });

  it('starts the next run on the step that worked, reading one page for one credit', async () => {
    const before = (await passgateUsage(mock)).credits_used;
    const summary = await run(mock, sourceId);
    expect(summary).toMatchObject({ status: 'succeeded', itemsNew: 0, pages: 1 });
    expect((await passgateUsage(mock)).credits_used - before).toBe(1);
  });

  it('fails as blocked, without paying, when the source may not use the unblocker', async () => {
    const id = await ratewellSource({ company: 'ledgerly', strategies: ['html', 'browser'] }, 'no unblocker');
    const summary = await run(mock, id);
    expect(summary).toMatchObject({ status: 'failed', errorClass: 'blocked' });
    expect(summary.errorMessage).toMatch(/no higher step/);
    expect((await costRows(id)).filter((c) => c.provider === 'passgate')).toEqual([]);
  }, 120_000);
});

describe('spending limits', () => {
  beforeEach(async () => truncateAll(db));

  it('stops as partial when PassGate credits run out, keeping what it got', async () => {
    const mock = await startMockWeb();
    try {
      await mock.admin('PUT', '/chaos/ratewell', { botCheckLevel: 3 });
      await mock.admin('POST', '/credits', { site: 'passgate', balance: 3 });
      const sourceId = await ratewellSource({ strategies: ['unblocker'] }, 'few credits');
      const summary = await run(mock, sourceId);
      expect(summary).toMatchObject({ status: 'partial', errorClass: 'quota', itemsNew: 60 });
      expect(await db.db.select().from(checkpoints)).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it("stops as partial at the source's monthly budget, before overspending", async () => {
    const mock = await startMockWeb();
    try {
      await mock.admin('PUT', '/chaos/ratewell', { botCheckLevel: 3 });
      const sourceId = await ratewellSource({ strategies: ['unblocker'] }, 'small budget');
      // $0.01 at $0.002 a credit: five pages.
      await db.db.update(sources).set({ budgetUsdMonth: 0.01 }).where(eq(sources.id, sourceId));
      const summary = await run(mock, sourceId);
      expect(summary).toMatchObject({ status: 'partial', errorClass: 'quota', itemsNew: 100 });
      expect(summary.errorMessage).toMatch(/budget/);
      const [spent] = await db.db
        .select({ usd: sql<number>`sum(${costs.usd})`.mapWith(Number) })
        .from(costs)
        .where(and(eq(costs.sourceId, sourceId)));
      expect(spent!.usd).toBeLessThanOrEqual(0.01 + 1e-9);
    } finally {
      await mock.close();
    }
  });
});

describe('the rendered-page fallback', () => {
  it('reads the same reviews from a PassGate-rendered page as from the data JSON', async () => {
    const mock = await startMockWeb();
    try {
      const auth = { headers: { authorization: 'Bearer pg-dev-key' } };
      const pg = (q: string) => `${mock.url}/passgate/v1/fetch?${q}`;
      const jsonUrl = pg(`url=${encodeURIComponent(`/ratewell/_data/company/${COMPANY}/reviews?page=3`)}`);
      const htmlUrl = pg(`url=${encodeURIComponent(`/ratewell/company/${COMPANY}`)}&render=true&page=3`);
      const get = async (url: string) => {
        const res = await fetch(url, auth);
        return { url, status: res.status, headers: {}, body: await res.text(), fetchedAt: new Date() };
      };
      const fromJson = parseReviewsJson(await get(jsonUrl)).reviews.map(reviewToItem);
      const fromHtml = parseRenderedHtml(await get(htmlUrl)).reviews.map(reviewToItem);
      expect(fromHtml).toHaveLength(20);
      // The rendered page has no "verified" flag; everything else matches.
      const comparable = (xs: typeof fromJson) => xs.map((x) => ({ ...x, text: normalizeText(x.text), meta: { rating: x.meta?.rating } }));
      expect(comparable(fromHtml)).toEqual(comparable(fromJson));
    } finally {
      await mock.close();
    }
  });
});
