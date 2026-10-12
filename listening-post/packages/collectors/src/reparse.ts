import { gunzipSync } from 'node:zlib';
import { rawResponses, runs, sources } from '@lp/db';
import { and, asc, eq, gt, isNotNull } from 'drizzle-orm';
import { CollectorError } from './errors';
import { createCollector as defaultCreateCollector } from './registry';
import { upsertItems, type ExecutorDeps, type RunSummary } from './run';

/**
 * Re-runs the source's parser over every raw response still stored for it, oldest first, and
 * upserts the items. No requests are made. Use it after fixing a parser for a layout change: the
 * responses that failed to parse are still stored, so the data comes back without collecting again.
 *
 * The run is `succeeded` when every response parses, and `partial` (class `parse`) when some still
 * do not, with the first error in the message.
 */
export async function executeReparse(deps: ExecutorDeps, runId: string): Promise<RunSummary> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const [row] = await db.select({ run: runs, source: sources }).from(runs).innerJoin(sources, eq(runs.sourceId, sources.id)).where(eq(runs.id, runId));
  if (!row) throw new Error(`run ${runId} not found`);
  const { source } = row;
  const log = deps.log.child({ runId, sourceId: source.id, reparse: true });
  await db.update(runs).set({ status: 'running', startedAt: new Date(now()) }).where(eq(runs.id, runId));

  const counters = { pages: 0, requests: 0, itemsFound: 0, itemsNew: 0 };
  let failures = 0;
  let firstError: string | null = null;
  try {
    const collector = (deps.createCollector ?? defaultCreateCollector)(source, deps.collectorDeps);
    const stored = await db
      .select({ id: rawResponses.id, url: rawResponses.url, status: rawResponses.httpStatus, headers: rawResponses.headers, body: rawResponses.body, sha256: rawResponses.sha256, fetchedAt: rawResponses.fetchedAt })
      .from(rawResponses)
      .innerJoin(runs, eq(rawResponses.runId, runs.id))
      .where(and(eq(runs.sourceId, source.id), gt(rawResponses.expiresAt, new Date(now()))))
      .orderBy(asc(rawResponses.fetchedAt), asc(rawResponses.id));

    for (const r of stored) {
      if (r.status !== 200) continue;
      // A body is stored once; later identical fetches of the URL keep only its hash.
      const body = r.body ?? (await bodyByHash(deps, r.sha256));
      if (!body) continue;
      const raw = { url: r.url, status: r.status, headers: r.headers as Record<string, string>, body: gunzipSync(body).toString('utf8'), fetchedAt: r.fetchedAt };
      counters.pages += 1;
      try {
        const { found, inserted } = await upsertItems(db, source, r.id, collector.parse(raw));
        counters.itemsFound += found;
        counters.itemsNew += inserted;
      } catch (err) {
        if (!(err instanceof CollectorError) || err.errorClass !== 'parse') throw err;
        failures += 1;
        firstError ??= err.message;
      }
    }

    const status = failures > 0 ? 'partial' : 'succeeded';
    const errorMessage = failures > 0 ? `${failures} stored responses still do not parse; first: ${firstError}` : null;
    await db
      .update(runs)
      .set({ status, ...counters, finishedAt: new Date(now()), errorClass: failures > 0 ? 'parse' : null, errorMessage })
      .where(eq(runs.id, runId));
    log.info({ ...counters, failures }, 'reparse finished');
    return { runId, status, ...counters, errorClass: failures > 0 ? 'parse' : null, errorMessage };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await db.update(runs).set({ status: 'failed', ...counters, finishedAt: new Date(now()), errorClass: 'bad_request', errorMessage }).where(eq(runs.id, runId));
    log.error({ err }, 'reparse failed');
    return { runId, status: 'failed', ...counters, errorClass: 'bad_request', errorMessage };
  }
}

async function bodyByHash(deps: ExecutorDeps, sha256: string): Promise<Buffer | null> {
  const [r] = await deps.db
    .select({ body: rawResponses.body })
    .from(rawResponses)
    .where(and(eq(rawResponses.sha256, sha256), isNotNull(rawResponses.body)))
    .limit(1);
  return r?.body ?? null;
}
