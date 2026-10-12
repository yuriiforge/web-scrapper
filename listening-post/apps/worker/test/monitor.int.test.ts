// Build step 6 acceptance checks: every failure mode mock-web can produce opens its alert, the alert
// closes once the failure stops, and both changes reach the webhook. Plus re-parse after a parser fix.
import { createServer, type Server } from 'node:http';
import { PgRateLimiter, ThreaditCollector, createCollector, createRun, executeReparse, executeRun, type RawResponse } from '@lp/collectors';
import { alerts, items, runs, sources, type DbHandle } from '@lp/db';
import type { ThreaditConfig } from '@lp/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSource, executorDeps, freshDatabase, startMockWeb, truncateAll, type MockWeb } from '../../../packages/collectors/test/harness';
import { runMonitor, type MonitorDeps } from '../src/monitor';

let db: DbHandle;
let mock: MockWeb;
let hook: Server;
let hookUrl: string;
const hookEvents: { event: string; alert: { kind: string } }[] = [];

beforeAll(async () => {
  db = await freshDatabase();
  hook = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hookEvents.push(JSON.parse(body));
      res.end('ok');
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
  hookUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}/hook`;
});
afterAll(async () => {
  await new Promise((r) => hook.close(r));
  await db?.close();
});
beforeEach(async () => {
  await truncateAll(db);
  await db.db.delete(alerts);
  hookEvents.length = 0;
  mock = await startMockWeb({ THREADIT_RATE: '100000', CHIRP_RATE: '100000' });
});

function monitorDeps(overrides: Partial<MonitorDeps> = {}): MonitorDeps {
  return { db: db.db, log: pino({ level: 'silent' }), cronIntervalMs: () => 5 * 60_000, hosts: [mock.url], webhookUrl: hookUrl, ...overrides };
}

const run = async (sourceId: string) => executeRun(executorDeps(db, mock), await createRun(db.db, sourceId, 'manual'));

async function openKinds(sourceId?: string): Promise<string[]> {
  const rows = await db.db
    .select({ kind: alerts.kind })
    .from(alerts)
    .where(and(isNull(alerts.resolvedAt), sourceId ? eq(alerts.sourceId, sourceId) : undefined));
  return rows.map((r) => r.kind).sort();
}

/** Opens under the chaos setting, closes once it is lifted; both reach the webhook. */
async function expectOpensThenCloses(sourceId: string, kind: string, during: () => Promise<void>, after: () => Promise<void>) {
  await during();
  await runMonitor(monitorDeps());
  expect(await openKinds(sourceId)).toContain(kind);
  await after();
  await runMonitor(monitorDeps());
  expect(await openKinds(sourceId)).not.toContain(kind);
  expect(hookEvents.filter((e) => e.alert.kind === kind).map((e) => e.event)).toEqual(['opened', 'resolved']);
}

describe('chaos settings open and close their alerts', () => {
  it('errorRate 1: run_failed', async () => {
    const id = await createSource(db, { community: 'pl', includeComments: false, maxPages: 1 });
    await run(id);
    await expectOpensThenCloses(
      id,
      'run_failed',
      async () => {
        await mock.admin('PUT', '/chaos/threadit', { errorRate: 1 });
        expect((await run(id)).status).toBe('failed');
      },
      async () => {
        await mock.admin('PUT', '/chaos/threadit', { errorRate: 0 });
        expect((await run(id)).status).toBe('succeeded');
      },
    );
  });

  it('emptyResults: zero_items', async () => {
    const id = await createSource(db, { community: 'pl', includeComments: false, maxPages: 1 });
    await run(id);
    await expectOpensThenCloses(
      id,
      'zero_items',
      async () => {
        await mock.admin('PUT', '/chaos/threadit', { emptyResults: true });
        await run(id);
      },
      async () => {
        await mock.admin('PUT', '/chaos/threadit', { emptyResults: false });
        await run(id);
      },
    );
  });

  it('layoutVersion 2: layout_changed', async () => {
    const id = await createSource(db, { community: 'pl', includeComments: false, maxPages: 1 });
    await run(id);
    await expectOpensThenCloses(
      id,
      'layout_changed',
      async () => {
        await mock.admin('PUT', '/chaos/threadit', { layoutVersion: 2 });
        await run(id);
      },
      async () => {
        await mock.admin('PUT', '/chaos/threadit', { layoutVersion: 1 });
        await run(id);
      },
    );
  });

  it('botCheckLevel 3: escalated', async () => {
    const id = await createSource(db, { company: 'fairwing', maxPages: 1 }, 'ratewell', 'ratewell');
    await expectOpensThenCloses(
      id,
      'escalated',
      async () => {
        await mock.admin('PUT', '/chaos/ratewell', { botCheckLevel: 3 });
        expect(await run(id)).toMatchObject({ status: 'succeeded' });
      },
      async () => {
        await mock.admin('PUT', '/chaos/ratewell', { botCheckLevel: 1 });
        // A new source starts on the cheapest step again; the escalated one keeps its step for a day.
        await db.db.update(sources).set({ config: { company: 'fairwing', maxPages: 1, strategies: ['html'], ratePerMinute: 100_000 } }).where(eq(sources.id, id));
        expect(await run(id)).toMatchObject({ status: 'succeeded' });
      },
    );
  }, 60_000);

  it('credits run out: quota', async () => {
    const id = await createSource(db, { query: 'airline', backfillDays: 365, maxPostsPerRun: 50 }, 'chirp', 'chirp');
    await expectOpensThenCloses(
      id,
      'quota',
      async () => {
        await mock.admin('POST', '/credits', { site: 'chirp', balance: 0 });
        expect((await run(id)).status).toBe('partial');
      },
      async () => {
        await mock.admin('POST', '/credits', { site: 'chirp', balance: 1000 });
        expect((await run(id)).status).toBe('succeeded');
      },
    );
  });

  it('spend passes 80% of the budget: budget', async () => {
    const id = await createSource(db, { query: 'airline', backfillDays: 365, maxPostsPerRun: 50 }, 'chirp budget', 'chirp');
    await expectOpensThenCloses(
      id,
      'budget',
      async () => {
        // 50 posts at $0.0005 = $0.025, which is over 80% of a $0.03 budget.
        await db.db.update(sources).set({ budgetUsdMonth: 0.03 }).where(eq(sources.id, id));
        await run(id);
      },
      async () => {
        await db.db.update(sources).set({ budgetUsdMonth: 10 }).where(eq(sources.id, id));
      },
    );
  });

  it('no successful run for twice the schedule interval: stale', async () => {
    const id = await createSource(db, { community: 'pl', includeComments: false, maxPages: 1 });
    await db.db.update(sources).set({ schedule: '*/5 * * * *', createdAt: new Date(Date.now() - 60 * 60_000) }).where(eq(sources.id, id));
    await expectOpensThenCloses(
      id,
      'stale',
      async () => {
        await db.db.insert(runs).values({ sourceId: id, trigger: 'schedule', status: 'succeeded', finishedAt: new Date(Date.now() - 30 * 60_000) });
      },
      async () => {
        await run(id);
      },
    );
  });

  it('the site stops answering: host_down (not tied to a source)', async () => {
    await runMonitor(monitorDeps({ hosts: ['http://127.0.0.1:9'] }));
    expect(await openKinds()).toEqual(['host_down']);
    await runMonitor(monitorDeps());
    expect(await openKinds()).toEqual([]);
    expect(hookEvents.map((e) => e.event)).toEqual(['opened', 'resolved']);
  });
});

describe('quiet sources raise nothing', () => {
  it('a rerun with nothing new, and 304s, open no alerts', async () => {
    const threadit = await createSource(db, { community: 'pl', includeComments: false, maxPages: 1 }, 'quiet threadit');
    const agora = await createSource(db, { category: 'meal-kits', maxTopics: 2 }, 'quiet agora', 'agora');
    const chirp = await createSource(db, { query: 'airline', backfillDays: 365 }, 'quiet chirp', 'chirp');
    for (const id of [threadit, agora, chirp]) {
      await run(id);
      await run(id);
      await run(id);
    }
    await runMonitor(monitorDeps());
    expect(await openKinds()).toEqual([]);
  }, 120_000);
});

describe('re-parse after a parser fix', () => {
  it('recovers the data a layout change broke, without a single new request', async () => {
    const id = await createSource(db, { community: 'pl', includeComments: false, maxPages: 2, pageSize: 50 });
    await mock.admin('PUT', '/chaos/threadit', { layoutVersion: 2 });
    const failed = await run(id);
    expect(failed).toMatchObject({ status: 'failed', errorClass: 'parse', itemsNew: 0 });

    // The "fix": a parser that also understands layout 2 (selftext renamed to body_text).
    class FixedThreadit extends ThreaditCollector {
      override parse(raw: RawResponse) {
        return super.parse({ ...raw, body: raw.body.replaceAll('"body_text":', '"selftext":') });
      }
    }
    const deps = {
      ...executorDeps(db, mock),
      limiter: new PgRateLimiter(db.db),
      createCollector: ((source, collectorDeps) =>
        source.site === 'threadit' ? new FixedThreadit(source.config as ThreaditConfig, collectorDeps) : createCollector(source, collectorDeps)) as typeof createCollector,
    };
    const requestsBefore = mock.ctx.state.requests.entries.length;
    const reparsed = await executeReparse(deps, await createRun(db.db, id, 'reparse'));

    expect(reparsed).toMatchObject({ status: 'succeeded', itemsNew: 50 });
    expect(mock.ctx.state.requests.entries.length).toBe(requestsBefore);
    const [n] = await db.db.select({ n: items.id }).from(items).limit(1);
    expect(n).toBeDefined();
  });

  it('reports partial when stored responses still do not parse', async () => {
    const id = await createSource(db, { community: 'pl', includeComments: false, maxPages: 1 });
    await mock.admin('PUT', '/chaos/threadit', { layoutVersion: 2 });
    await run(id);
    const reparsed = await executeReparse(executorDeps(db, mock), await createRun(db.db, id, 'reparse'));
    expect(reparsed).toMatchObject({ status: 'partial', errorClass: 'parse' });
    expect(reparsed.errorMessage).toMatch(/1 stored responses still do not parse/);
  });
});
