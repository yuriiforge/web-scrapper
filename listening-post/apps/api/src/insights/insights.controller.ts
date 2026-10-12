import { Controller, Get, Inject, Query } from '@nestjs/common';
import { clients, itemScores, items, sources, type Db } from '@lp/db';
import { CATEGORIES, SITES } from '@lp/shared';
import { and, count, desc, eq, gte, isNotNull, isNull, lt, max, sql } from 'drizzle-orm';
import { periodQuery, resolvePeriod, type PeriodQuery } from '../common/period';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DB } from '../tokens';

const DAY_MS = 86_400_000;

@Controller('insights')
export class InsightsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Items per day per site, by publish date, with empty days filled in. */
  @Get('volume')
  async volume(@Query(new ZodValidationPipe(periodQuery)) q: PeriodQuery) {
    const { from, to } = resolvePeriod(q);
    const day = sql<string>`to_char(date_trunc('day', ${items.publishedAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
    const rows = await this.db
      .select({ day, site: items.site, n: count() })
      .from(items)
      .where(and(gte(items.publishedAt, from), lt(items.publishedAt, to)))
      .groupBy(day, items.site);

    const days: string[] = [];
    for (let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); t < to.getTime(); t += DAY_MS) {
      days.push(new Date(t).toISOString().slice(0, 10));
    }
    const sitesWithData = SITES.filter((s) => rows.some((r) => r.site === s));
    const series = sitesWithData.map((site) => {
      const bySite = new Map(rows.filter((r) => r.site === site).map((r) => [r.day, r.n]));
      return { site, counts: days.map((d) => bySite.get(d) ?? 0) };
    });
    // The newest item overall, so a chart ending in empty days can say where the data stops.
    const [latest] = await this.db.select({ at: max(items.publishedAt) }).from(items);
    return { from: from.toISOString(), to: to.toISOString(), latestPublishedAt: latest?.at ?? null, days, series };
  }

  /** Items per country in the period; `country: null` collects items whose source gives none. */
  @Get('countries')
  async countries(@Query(new ZodValidationPipe(periodQuery)) q: PeriodQuery) {
    const { from, to } = resolvePeriod(q);
    const rows = await this.db
      .select({ country: items.country, n: count() })
      .from(items)
      .where(and(gte(items.publishedAt, from), lt(items.publishedAt, to)))
      .groupBy(items.country)
      .orderBy(desc(count()));
    return { from: from.toISOString(), to: to.toISOString(), countries: rows };
  }

  /** Items per source in the period. */
  @Get('sources')
  async bySource(@Query(new ZodValidationPipe(periodQuery)) q: PeriodQuery) {
    const { from, to } = resolvePeriod(q);
    const rows = await this.db
      .select({ sourceId: sources.id, sourceName: sources.name, site: sources.site, clientName: clients.name, n: count() })
      .from(items)
      .innerJoin(sources, eq(items.sourceId, sources.id))
      .innerJoin(clients, eq(sources.clientId, clients.id))
      .where(and(gte(items.publishedAt, from), lt(items.publishedAt, to)))
      .groupBy(sources.id, sources.name, sources.site, clients.name)
      .orderBy(desc(count()));
    return { from: from.toISOString(), to: to.toISOString(), sources: rows };
  }

  /**
   * Country x category sentiment: share positive minus share negative, with counts. Uses the model's
   * label where an item has one, else the rules label. Copies of a text (`duplicate_of`) count once.
   */
  @Get('sentiment')
  async sentiment(@Query(new ZodValidationPipe(periodQuery)) q: PeriodQuery) {
    const { from, to } = resolvePeriod(q);
    // One label per item: the model's when it gave one (a refusal leaves it empty), else the rules one.
    const best = this.db
      .selectDistinctOn([itemScores.itemId], {
        itemId: itemScores.itemId,
        method: itemScores.method,
        category: itemScores.category,
        sentiment: itemScores.sentiment,
      })
      .from(itemScores)
      .where(isNotNull(itemScores.sentiment))
      .orderBy(itemScores.itemId, sql`case ${itemScores.method} when 'llm' then 0 else 1 end`)
      .as('best');
    const rows = await this.db
      .select({
        country: items.country,
        category: best.category,
        n: count(),
        positive: sql<number>`count(*) filter (where ${best.sentiment} = 'positive')`.mapWith(Number),
        negative: sql<number>`count(*) filter (where ${best.sentiment} = 'negative')`.mapWith(Number),
      })
      .from(items)
      .innerJoin(best, eq(best.itemId, items.id))
      .where(and(gte(items.publishedAt, from), lt(items.publishedAt, to), isNull(items.duplicateOf)))
      .groupBy(items.country, best.category);
    const scored = rows.reduce((n, r) => n + r.n, 0);
    const [byModel] = await this.db
      .select({ n: count() })
      .from(items)
      .innerJoin(best, eq(best.itemId, items.id))
      .where(and(gte(items.publishedAt, from), lt(items.publishedAt, to), isNull(items.duplicateOf), eq(best.method, 'llm')));
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      scoredItems: scored,
      /** How many of them carry the model's label rather than the rules one. */
      llmScoredItems: byModel?.n ?? 0,
      categories: CATEGORIES,
      cells: rows.map((r) => ({ ...r, net: r.n > 0 ? (r.positive - r.negative) / r.n : 0 })),
    };
  }
}
