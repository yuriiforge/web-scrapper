import { gzipSync } from 'node:zlib';
import { checkpoints, costs, httpCache, items, rawResponses, runs, sources, type Db } from '@lp/db';
import type { RunStatus, RunTrigger, Strategy } from '@lp/shared';
import { and, desc, eq, gte, ne, sql, sum } from 'drizzle-orm';
import type { Logger } from 'pino';
import { CollectorError, errorClassOf } from './errors';
import { HttpClient, sleep as defaultSleep, type HttpClientOptions, type Sleep } from './http';
import { rateLimit, type PgRateLimiter } from './limiter';
import { normalizeText, sha256, textHash } from './normalize';
import { createCollector as defaultCreateCollector } from './registry';
import type { Collector, CollectorDeps, ParsedItem, RawResponse, RunContext } from './types';

export interface ExecutorDeps {
  db: Db;
  log: Logger;
  collectorDeps: CollectorDeps;
  limiter: PgRateLimiter;
  defaultRatePerMinute: number;
  rawRetentionDays: number;
  /** Overrides for tests. */
  createCollector?: typeof defaultCreateCollector;
  http?: Partial<Pick<HttpClientOptions, 'fetch' | 'baseDelayMs' | 'maxRetries' | 'random'>>;
  sleep?: Sleep;
  now?: () => number;
  /** How often a running run checks whether it was cancelled. */
  cancelPollMs?: number;
}

export interface RunSummary {
  runId: string;
  status: RunStatus;
  pages: number;
  requests: number;
  itemsFound: number;
  itemsNew: number;
  errorClass?: string | null;
  errorMessage?: string | null;
}

const TERMINAL: RunStatus[] = ['succeeded', 'partial', 'failed', 'cancelled'];

/** The database or a transaction on it. */
type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** Creates a queued run row and returns its id. */
export async function createRun(db: Db, sourceId: string, trigger: RunTrigger): Promise<string> {
  const [row] = await db.insert(runs).values({ sourceId, trigger }).returning({ id: runs.id });
  return row!.id;
}

/**
 * Runs one collection: page by page, each response stored raw, parsed, validated and upserted.
 * Safe to call twice for the same run (a retried job): a finished run is left alone, and upserts
 * on (site, external_id) never duplicate items. The checkpoint moves only when a run succeeds,
 * so a failed run is simply repeated from the old checkpoint next time.
 */
export async function executeRun(deps: ExecutorDeps, runId: string, signal?: AbortSignal): Promise<RunSummary> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;

  const [row] = await db
    .select({ run: runs, source: sources })
    .from(runs)
    .innerJoin(sources, eq(runs.sourceId, sources.id))
    .where(eq(runs.id, runId));
  if (!row) throw new Error(`run ${runId} not found`);
  const { run, source } = row;
  if (TERMINAL.includes(run.status)) return summaryOf(run);

  const log = deps.log.child({ runId, sourceId: source.id, site: source.site });
  const counters = { pages: 0, requests: 0, itemsFound: 0, itemsNew: 0 };
  await db
    .update(runs)
    .set({ status: 'running', startedAt: new Date(now()), errorClass: null, errorMessage: null })
    .where(eq(runs.id, runId));
  log.info({ trigger: run.trigger }, 'run started');

  /** Responses already stored this run, so an error does not store them twice. */
  const saved = new WeakSet<RawResponse>();
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });

  // A page can take minutes at a polite rate, so a cancel is picked up while it is in flight:
  // in-flight requests and waits are aborted, and what was already saved stays.
  let cancelled = false;
  const markCancelled = () => {
    if (cancelled) return;
    cancelled = true;
    controller.abort(new Error('run cancelled'));
  };
  const watcher = setInterval(() => {
    isCancelled(db, runId)
      .then((c) => c && markCancelled())
      .catch(() => undefined);
  }, deps.cancelPollMs ?? 2000);

  let collector: Collector | undefined;
  let ctx: RunContext | undefined;
  const strategyNow = () => collector?.strategy;

  try {
    collector = (deps.createCollector ?? defaultCreateCollector)(source, deps.collectorDeps);
    const perMinute = collector.ratePerMinute ?? deps.defaultRatePerMinute;
    const limit = collector.burst === undefined ? rateLimit(perMinute) : { perMinute, burst: collector.burst };
    const http = new HttpClient({
      log,
      signal: controller.signal,
      sleep,
      onAttempt: () => {
        counters.requests += 1;
      },
      // One bucket per site per host: several sites can share a host (they do in mock-web), each with its own limit.
      acquire: (url) => deps.limiter.acquire(`${source.site}:${new URL(url).host}`, limit, controller.signal),
      ...deps.http,
    });
    ctx = {
      http,
      log,
      signal: controller.signal,
      sleep,
      now,
      etag: async (url) => (await db.select({ etag: httpCache.etag }).from(httpCache).where(eq(httpCache.url, url)))[0]?.etag,
      charge: async (c) => {
        await db.insert(costs).values({ runId, clientId: source.clientId, sourceId: source.id, ...c });
        log.debug(c, 'charged');
      },
      budgetLeftUsd: async () => {
        if (source.budgetUsdMonth === null) return null;
        const [spent] = await db
          .select({ usd: sum(costs.usd).mapWith(Number) })
          .from(costs)
          .where(and(eq(costs.sourceId, source.id), gte(costs.createdAt, monthStartUtc(now()))));
        return source.budgetUsdMonth - (spent?.usd ?? 0);
      },
    };
    /** ETags of responses parsed this run; saved only if the run succeeds. */
    const etags = new Map<string, string>();
    const [cp] = await db.select().from(checkpoints).where(eq(checkpoints.sourceId, source.id));
    const expiresAt = new Date(now() + deps.rawRetentionDays * 86_400_000);

    let state: unknown = collector.initialState(cp?.cursor ?? null);
    while (state !== null) {
      if (await isCancelled(db, runId)) markCancelled();
      controller.signal.throwIfAborted();
      const page = await collector.fetchPage(ctx, state);
      for (const raw of page.responses) {
        const rawId = await saveRaw(db, runId, raw, expiresAt);
        saved.add(raw);
        const { found, inserted } = await upsertItems(db, source, rawId, collector.parse(raw));
        if (raw.status === 200 && raw.headers.etag) etags.set(raw.url, raw.headers.etag);
        counters.itemsFound += found;
        counters.itemsNew += inserted;
      }
      counters.pages += 1;
      await db.update(runs).set(counters).where(eq(runs.id, runId));
      state = page.next;
    }

    const done = collector;
    await db.transaction(async (tx) => {
      await saveCheckpoint(tx, source.id, done);
      await saveEtags(tx, etags);
      await finish(tx, runId, 'succeeded', counters, now, undefined, strategyNow());
    });
    log.info(counters, 'run succeeded');
    return { runId, status: 'succeeded', ...counters };
  } catch (err) {
    if (cancelled) {
      log.info(counters, 'run cancelled');
      await finish(db, runId, 'cancelled', counters, now, undefined, strategyNow());
      return { runId, status: 'cancelled', ...counters };
    }
    const aborted = controller.signal.aborted && !(err instanceof CollectorError);
    const errorClass = aborted ? 'transient' : errorClassOf(err);
    // Out of quota or timed out: keep what was saved and call it partial. Anything else failed.
    const status: RunStatus = errorClass === 'quota' || aborted ? 'partial' : 'failed';
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ err, errorClass, ...counters }, 'run ended with an error');
    // Keep the response that broke the run (e.g. after a layout change), so the parser can be fixed against it.
    if (err instanceof CollectorError) {
      const expiresAt = new Date(now() + deps.rawRetentionDays * 86_400_000);
      for (const raw of err.responses) if (!saved.has(raw)) await saveRaw(db, runId, raw, expiresAt).catch(() => undefined);
    }
    await finish(db, runId, status, counters, now, { errorClass, errorMessage }, strategyNow());
    return { runId, status, ...counters, errorClass, errorMessage };
  } finally {
    if (collector?.close && ctx) {
      await collector.close(ctx).catch((err: unknown) => log.warn({ err }, 'collector close failed'));
    }
    clearInterval(watcher);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function isCancelled(db: Db, runId: string): Promise<boolean> {
  const [r] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
  return r?.status === 'cancelled';
}

async function finish(
  db: DbOrTx,
  runId: string,
  status: RunStatus,
  counters: { pages: number; requests: number; itemsFound: number; itemsNew: number },
  now: () => number,
  error?: { errorClass: NonNullable<typeof runs.$inferInsert.errorClass>; errorMessage: string },
  strategy?: Strategy,
): Promise<void> {
  await db
    .update(runs)
    .set({
      status,
      ...counters,
      finishedAt: new Date(now()),
      errorClass: error?.errorClass ?? null,
      errorMessage: error?.errorMessage ?? null,
      strategy: strategy ?? null,
    })
    // A cancel that lands during the last page wins: never overwrite `cancelled` with another outcome.
    .where(status === 'cancelled' ? eq(runs.id, runId) : and(eq(runs.id, runId), ne(runs.status, 'cancelled')));
}

async function saveEtags(db: DbOrTx, etags: Map<string, string>): Promise<void> {
  if (etags.size === 0) return;
  const rows = [...etags].map(([url, etag]) => ({ url, etag, updatedAt: new Date() }));
  // Chunked: one statement has a parameter limit.
  for (let i = 0; i < rows.length; i += 1000) {
    await db
      .insert(httpCache)
      .values(rows.slice(i, i + 1000))
      .onConflictDoUpdate({ target: httpCache.url, set: { etag: sql`excluded.etag`, updatedAt: sql`excluded.updated_at` } });
  }
}

async function saveCheckpoint(db: DbOrTx, sourceId: string, collector: Collector): Promise<void> {
  const cursor = collector.checkpoint();
  await db
    .insert(checkpoints)
    .values({ sourceId, cursor, escalationStep: collector.strategy, updatedAt: new Date() })
    .onConflictDoUpdate({ target: checkpoints.sourceId, set: { cursor, escalationStep: collector.strategy, updatedAt: new Date() } });
}

/** Stores a response before it is parsed. The body is gzipped, and skipped when unchanged since the last fetch of that URL. */
async function saveRaw(db: Db, runId: string, raw: RawResponse, expiresAt: Date): Promise<number> {
  const hash = sha256(raw.body);
  const [previous] = await db
    .select({ sha256: rawResponses.sha256 })
    .from(rawResponses)
    .where(eq(rawResponses.url, raw.url))
    .orderBy(desc(rawResponses.fetchedAt))
    .limit(1);
  const [row] = await db
    .insert(rawResponses)
    .values({
      runId,
      url: raw.url,
      httpStatus: raw.status,
      headers: raw.headers,
      body: previous?.sha256 === hash ? null : gzipSync(raw.body),
      sha256: hash,
      fetchedAt: raw.fetchedAt,
      expiresAt,
    })
    .returning({ id: rawResponses.id });
  return row!.id;
}

/** Inserts or refreshes items; returns how many were seen and how many were new. */
async function upsertItems(
  db: Db,
  source: { id: string; site: typeof sources.$inferSelect.site },
  rawResponseId: number,
  parsed: ParsedItem[],
): Promise<{ found: number; inserted: number }> {
  // One statement cannot touch the same row twice, so keep the last copy of each id.
  const unique = [...new Map(parsed.map((p) => [p.externalId, p])).values()];
  if (unique.length === 0) return { found: 0, inserted: 0 };
  const rows = unique.map((p) => {
    const text = normalizeText(p.text);
    return {
      sourceId: source.id,
      site: source.site,
      externalId: p.externalId,
      author: p.author,
      text,
      textHash: textHash(text),
      country: p.country,
      publishedAt: p.publishedAt,
      rawResponseId,
      meta: p.meta ?? {},
    };
  });
  const result = await db
    .insert(items)
    .values(rows)
    .onConflictDoUpdate({
      target: [items.site, items.externalId],
      set: {
        text: sql`excluded.text`,
        author: sql`excluded.author`,
        textHash: sql`excluded.text_hash`,
        country: sql`excluded.country`,
        publishedAt: sql`excluded.published_at`,
        rawResponseId: sql`excluded.raw_response_id`,
        meta: sql`excluded.meta`,
      },
    })
    // xmax = 0 only on rows this statement inserted rather than updated.
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  return { found: unique.length, inserted: result.filter((r) => r.inserted).length };
}

/** Start of the calendar month (UTC) containing `ms`; monthly budgets reset then. */
function monthStartUtc(ms: number): Date {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function summaryOf(run: typeof runs.$inferSelect): RunSummary {
  return {
    runId: run.id,
    status: run.status,
    pages: run.pages,
    requests: run.requests,
    itemsFound: run.itemsFound,
    itemsNew: run.itemsNew,
    errorClass: run.errorClass,
    errorMessage: run.errorMessage,
  };
}
