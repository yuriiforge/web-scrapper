import { evalResults, itemScores, items, type Db } from '@lp/db';
import { CATEGORIES, SENTIMENTS, SITES, type Category, type ScoreMethod, type Sentiment, type Site } from '@lp/shared';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

const TruthRow = z.object({ id: z.string(), category: z.enum(CATEGORIES), sentiment: z.enum(SENTIMENTS) });
type Truth = z.infer<typeof TruthRow>;

/** mock-web answers at most this many ids per request. */
const TRUTH_CHUNK = 500;

/** The ground-truth endpoint could not be reached or answered with an error. */
export class TruthUnavailableError extends Error {}

/** Ground-truth labels by item id, from mock-web's `/_admin/truth`. Unknown ids are left out. */
export async function fetchTruth(truthUrl: string, ids: string[], fetchImpl: typeof fetch = fetch): Promise<Map<string, Truth>> {
  const out = new Map<string, Truth>();
  for (let i = 0; i < ids.length; i += TRUTH_CHUNK) {
    const url = new URL(truthUrl);
    url.searchParams.set('ids', ids.slice(i, i + TRUTH_CHUNK).join(','));
    const where = `${url.origin}${url.pathname}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) }).catch((err: unknown) => {
      throw new TruthUnavailableError(`${where} unreachable: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (!res.ok) throw new TruthUnavailableError(`${where} returned ${res.status}`);
    for (const row of z.array(TruthRow).parse(await res.json())) out.set(row.id, row);
  }
  return out;
}

export interface ClassMetrics {
  precision: number;
  recall: number;
  f1: number;
  /** Items whose true label is this class. */
  support: number;
}

export interface EvalPair {
  site: Site;
  predicted: { category: Category | null; sentiment: Sentiment | null };
  truth: { category: Category; sentiment: Sentiment };
}

export interface EvalMetrics {
  sampleSize: number;
  categoryAccuracy: number;
  sentimentAccuracy: number;
  detail: {
    category: Record<Category, ClassMetrics>;
    sentiment: Record<Sentiment, ClassMetrics>;
    macroF1: { category: number; sentiment: number };
    /** Rows are true labels, columns predicted; `none` is an item left unlabelled. */
    sentimentConfusion: Record<Sentiment, Record<Sentiment | 'none', number>>;
    bySite: Partial<Record<Site, { n: number; categoryAccuracy: number; sentimentAccuracy: number }>>;
  };
}

/** Accuracy and per-class F1. An unlabelled prediction counts as wrong. */
export function computeMetrics(pairs: EvalPair[]): EvalMetrics {
  const perClass = <L extends string>(labels: readonly L[], get: (p: EvalPair) => [L, L | null]) => {
    const out = {} as Record<L, ClassMetrics>;
    for (const label of labels) {
      let tp = 0;
      let fp = 0;
      let fn = 0;
      for (const p of pairs) {
        const [truth, predicted] = get(p);
        if (predicted === label && truth === label) tp++;
        else if (predicted === label) fp++;
        else if (truth === label) fn++;
      }
      const precision = tp + fp ? tp / (tp + fp) : 0;
      const recall = tp + fn ? tp / (tp + fn) : 0;
      const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
      out[label] = { precision: r(precision), recall: r(recall), f1: r(f1), support: tp + fn };
    }
    return out;
  };
  const category = perClass(CATEGORIES, (p) => [p.truth.category, p.predicted.category]);
  const sentiment = perClass(SENTIMENTS, (p) => [p.truth.sentiment, p.predicted.sentiment]);
  const macro = (m: Record<string, ClassMetrics>) => {
    const present = Object.values(m).filter((c) => c.support > 0);
    return present.length ? r(present.reduce((s, c) => s + c.f1, 0) / present.length) : 0;
  };
  const acc = (ps: EvalPair[], key: 'category' | 'sentiment') =>
    ps.length ? r(ps.filter((p) => p.predicted[key] === p.truth[key]).length / ps.length) : 0;

  const sentimentConfusion = Object.fromEntries(
    SENTIMENTS.map((t) => [
      t,
      Object.fromEntries([...SENTIMENTS, 'none' as const].map((p) => [p, pairs.filter((x) => x.truth.sentiment === t && (x.predicted.sentiment ?? 'none') === p).length])),
    ]),
  ) as EvalMetrics['detail']['sentimentConfusion'];

  const bySite: EvalMetrics['detail']['bySite'] = {};
  for (const site of SITES) {
    const ps = pairs.filter((p) => p.site === site);
    if (ps.length) bySite[site] = { n: ps.length, categoryAccuracy: acc(ps, 'category'), sentimentAccuracy: acc(ps, 'sentiment') };
  }

  return {
    sampleSize: pairs.length,
    categoryAccuracy: acc(pairs, 'category'),
    sentimentAccuracy: acc(pairs, 'sentiment'),
    detail: { category, sentiment, macroF1: { category: macro(category), sentiment: macro(sentiment) }, sentimentConfusion, bySite },
  };
}

export class NothingToEvaluateError extends Error {}

/**
 * Scores a random sample of one method's labels against ground truth and stores the result.
 * Only items mock-web knows count, so the stored sample size can be below the one asked for.
 */
export async function runEvaluation(
  db: Db,
  opts: { truthUrl: string; method: ScoreMethod; sampleSize: number; fetch?: typeof fetch },
): Promise<typeof evalResults.$inferSelect> {
  const sample = await db
    .select({ externalId: items.externalId, site: items.site, category: itemScores.category, sentiment: itemScores.sentiment })
    .from(itemScores)
    .innerJoin(items, eq(items.id, itemScores.itemId))
    .where(and(eq(itemScores.method, opts.method), sql`length(${items.text}) > 0`))
    .orderBy(sql`random()`)
    .limit(opts.sampleSize);
  if (sample.length === 0) throw new NothingToEvaluateError(`No items have a ${opts.method} score yet.`);

  const truth = await fetchTruth(opts.truthUrl, sample.map((s) => s.externalId), opts.fetch);
  const pairs: EvalPair[] = [];
  for (const s of sample) {
    const t = truth.get(s.externalId);
    if (t) pairs.push({ site: s.site, predicted: { category: s.category, sentiment: s.sentiment }, truth: t });
  }
  if (pairs.length === 0) throw new NothingToEvaluateError('The truth endpoint knows none of the sampled items.');

  const m = computeMetrics(pairs);
  const [row] = await db
    .insert(evalResults)
    .values({ method: opts.method, sampleSize: m.sampleSize, categoryAccuracy: m.categoryAccuracy, sentimentAccuracy: m.sentimentAccuracy, f1ByClass: m.detail })
    .returning();
  return row!;
}

function r(n: number): number {
  return Math.round(n * 1000) / 1000;
}
