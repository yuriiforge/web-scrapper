// The REST API against a real database: validation, CRUD, run control, and the dashboard reports.
import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { clients, costs, itemScores, items, runs, sources, type DbHandle } from '@lp/db';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL, freshDatabase } from '../../../packages/collectors/test/harness';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/setup';

let db: DbHandle;
let app: INestApplication;
let api: ReturnType<typeof request>;
let clientId: string;
let truthServer: Server;
let truthUrl: string;

/** Stands in for mock-web's /_admin/truth: knows ap_1 and ap_2 only. */
const TRUTH: Record<string, { category: string; sentiment: string }> = {
  ap_1: { category: 'price', sentiment: 'positive' },
  ap_2: { category: 'delivery', sentiment: 'negative' },
};

beforeAll(async () => {
  db = await freshDatabase();
  truthServer = createServer((req, res) => {
    const ids = new URL(req.url!, 'http://x').searchParams.get('ids')?.split(',') ?? [];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(ids.filter((i) => TRUTH[i]).map((i) => ({ id: i, site: 'agora', ...TRUTH[i] }))));
  });
  await new Promise<void>((resolve) => truthServer.listen(0, '127.0.0.1', resolve));
  truthUrl = `http://127.0.0.1:${(truthServer.address() as AddressInfo).port}/_admin/truth`;
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register({ DATABASE_URL: TEST_DATABASE_URL, LOG_LEVEL: 'silent', API_PORT: 0, TRUTH_URL: truthUrl })],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();
  api = request(app.getHttpServer());
});

afterAll(async () => {
  await app?.close();
  truthServer?.close();
  await db?.close();
});

describe('clients and sources', () => {
  it('creates a client and rejects a duplicate name', async () => {
    const res = await api.post('/api/clients').send({ name: 'Acme' }).expect(201);
    clientId = res.body.id;
    expect((await api.post('/api/clients').send({ name: 'Acme' }).expect(409)).body).toEqual({ error: 'conflict', field: 'name' });
  });

  it('validates sources per site and applies defaults', async () => {
    const bad = await api.post('/api/sources').send({ clientId, name: 'x', site: 'agora', config: { category: 'Meal Kits' } }).expect(400);
    expect(bad.body).toMatchObject({ error: 'bad_request', field: 'config.category' });
    expect((await api.post('/api/sources').send({ clientId, name: 'x', site: 'nowhere', config: {} }).expect(400)).body.field).toBe('site');

    const created = await api.post('/api/sources').send({ clientId, name: 'Agora · meal-kits', site: 'agora', config: { category: 'meal-kits' } }).expect(201);
    expect(created.body).toMatchObject({ site: 'agora', strategy: 'html', enabled: true, schedule: null, config: { category: 'meal-kits', format: 'json' } });

    const unknownClient = await api
      .post('/api/sources')
      .send({ clientId: '00000000-0000-4000-8000-000000000000', name: 'y', site: 'threadit', config: { community: 'gb' } })
      .expect(400);
    expect(unknownClient.body.field).toBe('clientId');
  });

  it('re-validates config against the source site on update', async () => {
    const [source] = (await api.get('/api/sources').expect(200)).body;
    const bad = await api.patch(`/api/sources/${source.id}`).send({ config: { format: 'pdf' } }).expect(400);
    expect(bad.body.field).toBe('config.format');
    const ok = await api.patch(`/api/sources/${source.id}`).send({ schedule: '*/10 * * * *', config: { category: 'meal-kits', format: 'html' } }).expect(200);
    expect(ok.body).toMatchObject({ schedule: '*/10 * * * *', config: { format: 'html' } });
    expect((await api.patch(`/api/sources/${source.id}`).send({ schedule: 'often' }).expect(400)).body.field).toBe('schedule');
  });

  it('returns JSON 404s and 400s for unknown or malformed ids', async () => {
    expect((await api.get('/api/sources/00000000-0000-4000-8000-000000000000').expect(404)).body).toEqual({ error: 'not_found' });
    expect((await api.get('/api/sources/not-a-uuid').expect(400)).body.error).toBe('bad_request');
  });
});

describe('runs', () => {
  it('queues a run, cancels it once, and refuses to run a disabled source', async () => {
    const [source] = (await api.get('/api/sources').expect(200)).body;
    const run = (await api.post(`/api/sources/${source.id}/runs`).expect(202)).body;
    expect(run).toMatchObject({ sourceId: source.id, status: 'queued', trigger: 'manual' });
    const [job] = (await db.db.execute<{ n: number }>(sql`select count(*)::int as n from pgboss.job where name = 'collect'`)).rows;
    expect(job!.n).toBe(1);

    expect((await api.post(`/api/runs/${run.id}/cancel`).expect(201)).body).toMatchObject({ status: 'cancelled' });
    expect((await api.post(`/api/runs/${run.id}/cancel`).expect(409)).body).toEqual({ error: 'not_cancellable' });

    const listed = (await api.get(`/api/runs?sourceId=${source.id}`).expect(200)).body;
    expect(listed[0]).toMatchObject({ id: run.id, status: 'cancelled', requests: 0, sourceName: source.name });

    await api.patch(`/api/sources/${source.id}`).send({ enabled: false }).expect(200);
    expect((await api.post(`/api/sources/${source.id}/runs`).expect(409)).body).toEqual({ error: 'source_disabled' });
    await api.patch(`/api/sources/${source.id}`).send({ enabled: true }).expect(200);
  });
});

describe('dashboard reports', () => {
  let sourceId: string;

  beforeAll(async () => {
    const [source] = await db.db.select({ id: sources.id }).from(sources);
    sourceId = source!.id;
    const now = Date.now();
    // Five items over three days, two countries, one without a country.
    const rows = [
      { externalId: 'ap_1', text: 'Great pricing at Forkfold.', country: 'GB', daysAgo: 0 },
      { externalId: 'ap_2', text: 'Delivery was late.', country: 'GB', daysAgo: 0 },
      { externalId: 'ap_3', text: 'Pricing is fair, 50% off.', country: 'DE', daysAgo: 1 },
      { externalId: 'ap_4', text: 'App is clunky.', country: null, daysAgo: 2 },
      { externalId: 'ap_5', text: 'Support was friendly.', country: 'DE', daysAgo: 2 },
    ];
    await db.db.insert(items).values(
      rows.map((r) => ({
        sourceId,
        site: 'agora' as const,
        externalId: r.externalId,
        author: 'someone',
        text: r.text,
        textHash: r.externalId.padEnd(64, '0'),
        country: r.country,
        publishedAt: new Date(now - r.daysAgo * 86_400_000 - 60_000),
      })),
    );
    await db.db.insert(runs).values({ sourceId, trigger: 'manual', status: 'succeeded', requests: 40, itemsFound: 5, itemsNew: 5 });
    const [client] = await db.db.select({ id: clients.id }).from(clients);
    await db.db.insert(costs).values({ clientId: client!.id, sourceId, provider: 'passgate', units: 10, unit: 'credit', usd: 0.02 });
  });

  it('pages through items newest first with a cursor, each exactly once', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: request.Response = await api.get(`/api/items?limit=2${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
      seen.push(...res.body.items.map((i: { externalId: string }) => i.externalId));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['ap_2', 'ap_1', 'ap_3', 'ap_5', 'ap_4']);
    expect((await api.get('/api/items?cursor=garbage').expect(400)).body.field).toBe('cursor');
  });

  it('filters items by country, missing country and text, treating % literally', async () => {
    const ids = async (q: string) => (await api.get(`/api/items?${q}`).expect(200)).body.items.map((i: { externalId: string }) => i.externalId).sort();
    expect(await ids('country=DE')).toEqual(['ap_3', 'ap_5']);
    expect(await ids('country=none')).toEqual(['ap_4']);
    expect(await ids('q=pricing')).toEqual(['ap_1', 'ap_3']);
    expect(await ids(`q=${encodeURIComponent('50%')}`)).toEqual(['ap_3']);
    expect(await ids(`q=${encodeURIComponent('%')}`)).toEqual(['ap_3']);
  });

  it('returns one item with its source and scores', async () => {
    const list = (await api.get('/api/items?limit=1').expect(200)).body.items;
    const item = (await api.get(`/api/items/${list[0].id}`).expect(200)).body;
    expect(item).toMatchObject({ externalId: 'ap_2', sourceName: 'Agora · meal-kits', scores: [], raw: null });
    await api.get('/api/items/999999').expect(404);
  });

  it('summarises spend and usage per client and source', async () => {
    const res = (await api.get('/api/costs?days=7').expect(200)).body;
    expect(res.clients).toEqual([
      expect.objectContaining({ clientName: 'Acme', runs: 2, requests: 40, itemsNew: 5, usd: 0.02, usdPerNewItem: 0.004 }),
    ]);
    expect(res.providers).toEqual([{ provider: 'passgate', unit: 'credit', units: 10, usd: 0.02 }]);
  });

  it('reports volume per day per site with empty days filled', async () => {
    const res = (await api.get('/api/insights/volume?days=5').expect(200)).body;
    expect(res.days).toHaveLength(6);
    expect(res.series).toHaveLength(1);
    expect(res.series[0].site).toBe('agora');
    expect(res.series[0].counts.reduce((a: number, b: number) => a + b, 0)).toBe(5);
    expect(res.series[0].counts.slice(0, 2)).toEqual([0, 0]);
  });

  it('reports items per country and per source', async () => {
    const countries = (await api.get('/api/insights/countries?days=7').expect(200)).body.countries;
    expect(countries).toEqual(
      expect.arrayContaining([{ country: 'GB', n: 2 }, { country: 'DE', n: 2 }, { country: null, n: 1 }]),
    );
    const bySource = (await api.get('/api/insights/sources?days=7').expect(200)).body.sources;
    expect(bySource).toEqual([expect.objectContaining({ sourceName: 'Agora · meal-kits', clientName: 'Acme', n: 5 })]);
  });

  it('builds the sentiment grid from scores, preferring the LLM score', async () => {
    expect((await api.get('/api/insights/sentiment?days=7').expect(200)).body.scoredItems).toBe(0);
    const all = await db.db.select({ id: items.id, externalId: items.externalId }).from(items);
    const id = (ext: string) => all.find((i) => i.externalId === ext)!.id;
    await db.db.insert(itemScores).values([
      { itemId: id('ap_1'), method: 'rules', category: 'price', sentiment: 'negative' },
      { itemId: id('ap_1'), method: 'llm', category: 'price', sentiment: 'positive' },
      { itemId: id('ap_2'), method: 'rules', category: 'price', sentiment: 'negative' },
    ]);
    const res = (await api.get('/api/insights/sentiment?days=7').expect(200)).body;
    expect(res.scoredItems).toBe(2);
    expect(res.llmScoredItems).toBe(1);
    expect(res.cells).toEqual([{ country: 'GB', category: 'price', n: 2, positive: 1, negative: 1, net: 0 }]);
  });

  it('evaluates each method against ground truth and reports coverage', async () => {
    const all = await db.db.select({ id: items.id, externalId: items.externalId }).from(items);
    const id = (ext: string) => all.find((i) => i.externalId === ext)!.id;
    expect((await api.post('/api/analysis/evaluations').send({ method: 'rules', sampleSize: 5 }).expect(400)).body.field).toBe('sampleSize');

    // rules: ap_1 price/negative (truth price/positive), ap_2 price/negative (truth delivery/negative).
    const rules = (await api.post('/api/analysis/evaluations').send({ method: 'rules', sampleSize: 50 }).expect(201)).body;
    expect(rules).toMatchObject({ method: 'rules', sampleSize: 2, categoryAccuracy: 0.5, sentimentAccuracy: 0.5 });
    expect(rules.f1ByClass.category.delivery).toEqual({ precision: 0, recall: 0, f1: 0, support: 1 });
    const llm = (await api.post('/api/analysis/evaluations').send({ method: 'llm' }).expect(201)).body;
    expect(llm).toMatchObject({ method: 'llm', sampleSize: 1, categoryAccuracy: 1, sentimentAccuracy: 1 });

    const list = (await api.get('/api/analysis/evaluations').expect(200)).body;
    expect(list.map((e: { method: string }) => e.method)).toEqual(['llm', 'rules']);
    const status = (await api.get('/api/analysis').expect(200)).body;
    expect(status).toMatchObject({ items: 5, duplicates: 0, crossSiteDuplicates: 0, methods: { rules: { scored: 2, unlabelled: 0 }, llm: { scored: 1 } }, llmSpendMonthUsd: 0 });
    expect(Date.parse(status.methods.rules.latestAt)).not.toBeNaN();

    // ap_5 repeats ap_1 on another site; ap_4 repeats it on the same site.
    const [ap1, ap4, ap5] = ['ap_1', 'ap_4', 'ap_5'].map((e) => id(e));
    await db.db.update(items).set({ duplicateOf: ap1 }).where(sql`${items.id} in (${ap4}, ${ap5})`);
    await db.db.update(items).set({ site: 'chirp' }).where(sql`${items.id} = ${ap5}`);
    expect((await api.get('/api/analysis').expect(200)).body).toMatchObject({ duplicates: 2, crossSiteDuplicates: 1 });
    await db.db.update(items).set({ duplicateOf: null, site: 'agora' }).where(sql`${items.id} in (${ap4}, ${ap5})`);
  });

  it('gives the overview in one request', async () => {
    const res = (await api.get('/api/overview').expect(200)).body;
    expect(res).toMatchObject({ items: { total: 5 }, sources: { total: 1, enabled: 1, failing: 0 }, requests24h: 40, spendMonthUsd: 0.02 });
    expect(res.runs24h).toMatchObject({ succeeded: 1, cancelled: 1 });
    expect(res.recentRuns).toHaveLength(2);
  });

  it('rejects an inverted period', async () => {
    const res = await api.get('/api/costs?from=2026-10-09T00:00:00Z&to=2026-10-01T00:00:00Z').expect(400);
    expect(res.body.field).toBe('from');
  });
});

describe('API token', () => {
  it('requires the bearer token on /api when API_TOKEN is set, but not on /health', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register({ DATABASE_URL: TEST_DATABASE_URL, LOG_LEVEL: 'silent', API_PORT: 0, TRUTH_URL: truthUrl, API_TOKEN: 'a-token-long-enough-1234' })],
    }).compile();
    const locked = moduleRef.createNestApplication({ logger: false });
    configureApp(locked);
    await locked.init();
    try {
      const r = request(locked.getHttpServer());
      expect((await r.get('/api/sources').expect(401)).body).toEqual({ error: 'unauthorized' });
      await r.get('/api/sources').set('Authorization', 'Bearer wrong-token-of-same-size').expect(401);
      await r.get('/api/sources').set('Authorization', 'Bearer a-token-long-enough-1234').expect(200);
      await r.get('/health').expect(200);
    } finally {
      await locked.close();
    }
  });
});
