import { Controller, Get, Inject, Query } from '@nestjs/common';
import { clients, costs, runs, sources, type Db } from '@lp/db';
import { and, asc, count, eq, gte, lt, sum } from 'drizzle-orm';
import { periodQuery, resolvePeriod, type PeriodQuery } from '../common/period';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DB } from '../tokens';

@Controller('costs')
export class CostsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Spend and usage per client and source for a period. `usd` comes from the cost ledger
   * (paid providers); `requests` and `itemsNew` from runs, so free sources show their volume too.
   * `usdPerNewItem` is null when a source added nothing.
   */
  @Get()
  async get(@Query(new ZodValidationPipe(periodQuery)) q: PeriodQuery) {
    const { from, to } = resolvePeriod(q);
    const inRuns = and(gte(runs.createdAt, from), lt(runs.createdAt, to));
    const inCosts = and(gte(costs.createdAt, from), lt(costs.createdAt, to));

    const usage = await this.db
      .select({
        sourceId: runs.sourceId,
        runs: count(),
        requests: sum(runs.requests).mapWith(Number),
        itemsNew: sum(runs.itemsNew).mapWith(Number),
      })
      .from(runs)
      .where(inRuns)
      .groupBy(runs.sourceId);
    const spendBySource = await this.db
      .select({ sourceId: costs.sourceId, usd: sum(costs.usd).mapWith(Number) })
      .from(costs)
      .where(inCosts)
      .groupBy(costs.sourceId);
    const byProvider = await this.db
      .select({ provider: costs.provider, unit: costs.unit, units: sum(costs.units).mapWith(Number), usd: sum(costs.usd).mapWith(Number) })
      .from(costs)
      .where(inCosts)
      .groupBy(costs.provider, costs.unit)
      .orderBy(asc(costs.provider));
    const allSources = await this.db
      .select({ id: sources.id, name: sources.name, site: sources.site, strategy: sources.strategy, clientId: clients.id, clientName: clients.name, budgetUsdMonth: sources.budgetUsdMonth })
      .from(sources)
      .innerJoin(clients, eq(sources.clientId, clients.id))
      .orderBy(asc(clients.name), asc(sources.name));

    const usageBy = new Map(usage.map((u) => [u.sourceId, u]));
    const spendBy = new Map(spendBySource.map((s) => [s.sourceId, s.usd]));
    const rows = allSources.map((s) => {
      const u = usageBy.get(s.id);
      const usd = spendBy.get(s.id) ?? 0;
      const itemsNew = u?.itemsNew ?? 0;
      return {
        ...s,
        runs: u?.runs ?? 0,
        requests: u?.requests ?? 0,
        itemsNew,
        usd,
        usdPerNewItem: itemsNew > 0 ? usd / itemsNew : null,
      };
    });

    const clientTotals = [...new Map(rows.map((r) => [r.clientId, r.clientName])).entries()].map(([clientId, clientName]) => {
      const mine = rows.filter((r) => r.clientId === clientId);
      const usd = mine.reduce((n, r) => n + r.usd, 0);
      const itemsNew = mine.reduce((n, r) => n + r.itemsNew, 0);
      return {
        clientId,
        clientName,
        runs: mine.reduce((n, r) => n + r.runs, 0),
        requests: mine.reduce((n, r) => n + r.requests, 0),
        itemsNew,
        usd,
        usdPerNewItem: itemsNew > 0 ? usd / itemsNew : null,
      };
    });

    return { from: from.toISOString(), to: to.toISOString(), clients: clientTotals, sources: rows, providers: byProvider };
  }
}
