import { alerts, costs, items, rawResponses, runs, sources, type Db } from '@lp/db';
import { and, desc, eq, gte, inArray, isNull, ne, sql, sum } from 'drizzle-orm';
import type { Logger } from 'pino';

export const ALERT_KINDS = [
  'run_failed',
  'layout_changed',
  'quota',
  'budget',
  'escalated',
  'zero_items',
  'volume_drop',
  'field_coverage',
  'stale',
  'host_down',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** Something wrong right now. While it holds, its alert stays open; when it stops, the alert closes. */
export interface Condition {
  sourceId: string | null;
  kind: AlertKind;
  message: string;
}

export interface MonitorDeps {
  db: Db;
  log: Logger;
  /** Milliseconds between two occurrences of a cron expression, or null if it cannot be read. */
  cronIntervalMs: (cron: string) => number | null;
  /** Base URLs of the sites being collected; each is checked for reachability. */
  hosts: string[];
  /** Posts each opened or resolved alert as JSON, when set. */
  webhookUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const DAY_MS = 86_400_000;

/** Every condition that holds now, across all enabled sources and hosts. */
export async function evaluate(deps: MonitorDeps): Promise<Condition[]> {
  const { db } = deps;
  const now = deps.now?.() ?? Date.now();
  const out: Condition[] = [];
  const enabled = await db.select().from(sources).where(eq(sources.enabled, true));

  for (const source of enabled) {
    // Finished collection runs, newest first. Re-parse runs and cancelled runs say nothing about the site.
    const recent = await db
      .select()
      .from(runs)
      .where(and(eq(runs.sourceId, source.id), inArray(runs.status, ['succeeded', 'partial', 'failed']), ne(runs.trigger, 'reparse')))
      .orderBy(desc(runs.createdAt))
      .limit(10);
    const latest = recent[0];
    const add = (kind: AlertKind, message: string) => out.push({ sourceId: source.id, kind, message });

    if (latest?.status === 'failed') {
      if (latest.errorClass === 'parse') add('layout_changed', `The site's layout no longer matches the parser: ${latest.errorMessage}`);
      else add('run_failed', `Last run failed (${latest.errorClass}): ${latest.errorMessage}`);
    }
    if (latest?.status === 'partial' && latest.errorClass === 'quota') add('quota', `Last run stopped early: ${latest.errorMessage}`);

    const firstStep = (source.config as { strategies?: string[] }).strategies?.[0] ?? 'html';
    if (source.site === 'ratewell' && latest?.strategy && latest.strategy !== firstStep) {
      add('escalated', `Bot checks blocked the cheaper steps; the last run needed "${latest.strategy}", which costs money.`);
    }

    if (latest && checkZeroItems(source.site, latest, recent)) add('zero_items', "The last run's listings came back empty, though this source usually has entries.");
    const drop = latest ? checkVolumeDrop(source.site, latest, recent) : null;
    if (drop) add('volume_drop', drop);
    const coverage = latest ? await checkCoverage(db, source.id, latest, now) : null;
    if (coverage) add('field_coverage', coverage);

    const budget = await checkBudget(db, source, now);
    if (budget) add('budget', budget);

    if (source.schedule) {
      const interval = deps.cronIntervalMs(source.schedule);
      const lastGood = recent.find((r) => r.status !== 'failed');
      const since = lastGood?.finishedAt?.getTime() ?? source.createdAt.getTime();
      if (interval && now - since > 2 * interval) {
        add('stale', `No successful run for ${Math.round((now - since) / 60_000)} min; the schedule (${source.schedule}) expects one every ${Math.round(interval / 60_000)} min.`);
      }
    }
  }

  for (const host of deps.hosts) {
    if (!(await reachable(host, deps.fetch ?? fetch))) out.push({ sourceId: null, kind: 'host_down', message: `${host} is not reachable.` });
  }
  return out;
}

/** Opens alerts for new conditions, refreshes the message of ongoing ones, and resolves the rest. */
export async function reconcile(deps: MonitorDeps, conditions: Condition[]): Promise<{ opened: number; resolved: number }> {
  const { db } = deps;
  const key = (sourceId: string | null, kind: string) => `${sourceId ?? '-'}|${kind}`;
  const open = await db.select().from(alerts).where(isNull(alerts.resolvedAt));
  const openByKey = new Map(open.map((a) => [key(a.sourceId, a.kind), a]));
  const active = new Set(conditions.map((c) => key(c.sourceId, c.kind)));
  let opened = 0;
  let resolved = 0;

  for (const c of conditions) {
    const existing = openByKey.get(key(c.sourceId, c.kind));
    if (existing) {
      if (existing.message !== c.message) await db.update(alerts).set({ message: c.message }).where(eq(alerts.id, existing.id));
      continue;
    }
    const [row] = await db.insert(alerts).values(c).returning();
    opened += 1;
    deps.log.warn({ alert: row }, 'alert opened');
    await notify(deps, 'opened', row!);
  }
  for (const a of open) {
    if (active.has(key(a.sourceId, a.kind))) continue;
    const [row] = await db.update(alerts).set({ resolvedAt: new Date() }).where(eq(alerts.id, a.id)).returning();
    resolved += 1;
    deps.log.info({ alert: row }, 'alert resolved');
    await notify(deps, 'resolved', row!);
  }
  return { opened, resolved };
}

/** One monitoring pass. It runs as a job on an exclusive queue, so only one runs at a time across workers. */
export async function runMonitor(deps: MonitorDeps): Promise<{ opened: number; resolved: number }> {
  return reconcile(deps, await evaluate(deps));
}

type Run = typeof runs.$inferSelect;

// Both checks below use `listed` (entries the site's listings showed), not new items: a quiet period
// rightly brings no new items, but a listing that comes back empty means something is wrong.
// `listed` is null when no listing came back at all (e.g. a 304), and such runs are skipped.
// Chirp is left out: its searches are time windows, and an empty window is normal there.

/** A listing came back empty while earlier ones had entries: e.g. the site now returns empty results. */
function checkZeroItems(site: string, latest: Run, recent: Run[]): boolean {
  if (site === 'chirp' || latest.status !== 'succeeded' || latest.listed !== 0) return false;
  return recent.slice(1).some((r) => (r.listed ?? 0) > 0);
}

/** Listings much shorter than usual (below 30% of the median of earlier runs). */
function checkVolumeDrop(site: string, latest: Run, recent: Run[]): string | null {
  if (site === 'chirp' || latest.status !== 'succeeded' || !latest.listed) return null;
  const earlier = recent
    .slice(1)
    .filter((r) => r.status === 'succeeded' && (r.listed ?? 0) > 0)
    .map((r) => r.listed!);
  if (earlier.length < 3) return null;
  const median = [...earlier].sort((a, b) => a - b)[Math.floor(earlier.length / 2)]!;
  return latest.listed < 0.3 * median ? `The last run's listings showed ${latest.listed} entries; the usual is about ${median}.` : null;
}

/** The share of items with a country fell by more than 20 points against the past week. */
async function checkCoverage(db: Db, sourceId: string, latest: Run, now: number): Promise<string | null> {
  const share = async (where: ReturnType<typeof and>) => {
    const [r] = await db
      .select({ n: sql<number>`count(*)`.mapWith(Number), withCountry: sql<number>`count(${items.country})`.mapWith(Number) })
      .from(items)
      .innerJoin(rawResponses, eq(items.rawResponseId, rawResponses.id))
      .where(where);
    return r && r.n > 0 ? { n: r.n, share: r.withCountry / r.n } : null;
  };
  const last = await share(and(eq(items.sourceId, sourceId), eq(rawResponses.runId, latest.id)));
  const before = await share(
    and(eq(items.sourceId, sourceId), ne(rawResponses.runId, latest.id), gte(items.collectedAt, new Date(now - 7 * DAY_MS))),
  );
  if (!last || !before || last.n < 20 || before.share < 0.3) return null;
  const drop = before.share - last.share;
  return drop > 0.2
    ? `Only ${Math.round(last.share * 100)}% of the last run's items have a country, against ${Math.round(before.share * 100)}% over the past week.`
    : null;
}

async function checkBudget(db: Db, source: typeof sources.$inferSelect, now: number): Promise<string | null> {
  if (source.budgetUsdMonth === null || source.budgetUsdMonth <= 0) return null;
  const d = new Date(now);
  const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const [r] = await db
    .select({ usd: sum(costs.usd).mapWith(Number) })
    .from(costs)
    .where(and(eq(costs.sourceId, source.id), gte(costs.createdAt, monthStart)));
  const spent = r?.usd ?? 0;
  return spent >= 0.8 * source.budgetUsdMonth
    ? `$${spent.toFixed(4)} of the $${source.budgetUsdMonth.toFixed(2)} monthly budget is spent (${Math.round((spent / source.budgetUsdMonth) * 100)}%).`
    : null;
}

async function reachable(url: string, f: typeof fetch): Promise<boolean> {
  try {
    await f(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    return true; // any HTTP answer, even an error status, means the host is up
  } catch {
    return false;
  }
}

async function notify(deps: MonitorDeps, event: 'opened' | 'resolved', alert: typeof alerts.$inferSelect): Promise<void> {
  if (!deps.webhookUrl) return;
  try {
    await (deps.fetch ?? fetch)(deps.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event, alert }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    deps.log.warn({ err, event }, 'alert webhook failed');
  }
}
