import { Controller, Get, Inject } from '@nestjs/common';
import { alerts, costs, items, runs, sources, type Db } from '@lp/db';
import { RUN_STATUSES, type RunStatus } from '@lp/shared';
import { count, desc, eq, gte, isNull, sql, sum } from 'drizzle-orm';
import { monthStart } from '../common/period';
import { DB } from '../tokens';

@Controller('overview')
export class OverviewController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Everything the overview page shows, in one request. */
  @Get()
  async get() {
    const dayAgo = new Date(Date.now() - 86_400_000);

    const [itemTotals] = await this.db
      .select({ total: count(), last24h: sql<number>`count(*) filter (where ${items.collectedAt} >= ${dayAgo})`.mapWith(Number) })
      .from(items);

    const runCounts = await this.db
      .select({ status: runs.status, n: count(), requests: sum(runs.requests).mapWith(Number) })
      .from(runs)
      .where(gte(runs.createdAt, dayAgo))
      .groupBy(runs.status);
    const runs24h = Object.fromEntries(RUN_STATUSES.map((s) => [s, 0])) as Record<RunStatus, number>;
    for (const r of runCounts) runs24h[r.status] = r.n;

    const [spend] = await this.db
      .select({ usd: sum(costs.usd).mapWith(Number) })
      .from(costs)
      .where(gte(costs.createdAt, monthStart()));

    // Each source with its latest run, to find the ones that need attention.
    const latest = await this.db
      .selectDistinctOn([runs.sourceId], {
        sourceId: runs.sourceId,
        sourceName: sources.name,
        enabled: sources.enabled,
        runId: runs.id,
        status: runs.status,
        createdAt: runs.createdAt,
        errorClass: runs.errorClass,
        errorMessage: runs.errorMessage,
      })
      .from(runs)
      .innerJoin(sources, eq(runs.sourceId, sources.id))
      .orderBy(runs.sourceId, desc(runs.createdAt));
    const [sourceTotals] = await this.db
      .select({ total: count(), enabled: sql<number>`count(*) filter (where ${sources.enabled})`.mapWith(Number) })
      .from(sources);

    const recentRuns = await this.db
      .select({
        id: runs.id,
        sourceName: sources.name,
        site: sources.site,
        status: runs.status,
        createdAt: runs.createdAt,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
        itemsNew: runs.itemsNew,
      })
      .from(runs)
      .innerJoin(sources, eq(runs.sourceId, sources.id))
      .orderBy(desc(runs.createdAt))
      .limit(6);

    const openAlerts = await this.db
      .select({ id: alerts.id, sourceId: alerts.sourceId, sourceName: sources.name, kind: alerts.kind, message: alerts.message, openedAt: alerts.openedAt })
      .from(alerts)
      .leftJoin(sources, eq(alerts.sourceId, sources.id))
      .where(isNull(alerts.resolvedAt))
      .orderBy(desc(alerts.openedAt));

    return {
      alerts: openAlerts,
      items: { total: itemTotals?.total ?? 0, last24h: itemTotals?.last24h ?? 0 },
      sources: {
        total: sourceTotals?.total ?? 0,
        enabled: sourceTotals?.enabled ?? 0,
        failing: latest.filter((l) => l.enabled && (l.status === 'failed' || l.status === 'partial')).length,
      },
      runs24h,
      requests24h: runCounts.reduce((n, r) => n + (r.requests ?? 0), 0),
      spendMonthUsd: spend?.usd ?? 0,
      attention: latest.filter((l) => l.enabled && (l.status === 'failed' || l.status === 'partial')),
      recentRuns,
    };
  }
}

