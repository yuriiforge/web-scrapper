// Build step 7 acceptance checks: duplicates, both scorers, the cost ledger and evaluation against
// mock-web's ground truth, on a real Postgres.
import { costs, evalResults, itemScores, items, sources, type DbHandle } from '@lp/db';
import { asc, eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSource, freshDatabase, startMockWeb, truncateAll } from '../../collectors/test/harness';
import { textHash } from '../../collectors/src/normalize';
import { runEvaluation } from '../src/evaluate';
import type { Classifier, ClassifyInput } from '../src/llm';
import { markDuplicates, runAnalysis, type AnalysisDeps, type LlmSettings } from '../src/pipeline';

let db: DbHandle;
const log = pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' });

beforeAll(async () => {
  db = await freshDatabase();
});
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await truncateAll(db);
});

const COPIED = 'Shipping with Hopwell Air was faster than promised, and the crew were lovely.';

/** Two sources of one client; the copied text appears on both sites, a short reply twice on one. */
async function seed() {
  const forum = await createSource(db, { community: 'gb' }, 'forum', 'threadit');
  const social = await createSource(db, { query: 'air' }, 'social', 'chirp');
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 7, 12, minutes));
  const row = (sourceId: string, site: 'threadit' | 'chirp', externalId: string, text: string, minutes: number) => ({
    sourceId,
    site,
    externalId,
    text,
    textHash: textHash(text),
    publishedAt: at(minutes),
  });
  await db.db.insert(items).values([
    row(forum, 'threadit', 't1_a', COPIED, 1),
    row(forum, 'threadit', 't1_b', 'Thanks, same here!', 2),
    row(forum, 'threadit', 't1_c', 'Thanks, same here!', 3),
    row(forum, 'threadit', 't1_d', 'The Mintora app is a joy to use.', 4),
    row(forum, 'threadit', 't1_e', '', 5),
    row(social, 'chirp', 'ch_a', COPIED, 6),
  ]);
}

/** A classifier that labels everything usability/positive except texts containing "Thanks". */
function fakeClassifier(opts: { fail?: boolean } = {}) {
  const calls: ClassifyInput[][] = [];
  const classifier: Classifier = {
    model: 'fake-model',
    async classify(batch) {
      calls.push(batch);
      if (opts.fail) throw new Error('overloaded');
      const scores = new Map(
        batch.filter((b) => !b.text.includes('Thanks')).map((b) => [b.key, { category: 'usability' as const, sentiment: 'positive' as const, confidence: 0.9 }]),
      );
      return { scores, inputTokens: 1000, outputTokens: 200, model: 'fake-model', stopReason: 'end_turn' };
    },
  };
  return { classifier, calls };
}

const llm = (classifier: Classifier, over: Partial<LlmSettings> = {}): LlmSettings => ({
  classifier,
  maxItemsPerPass: 100,
  batchSize: 25,
  monthlyUsd: 5,
  inputUsdPerMTok: 4,
  outputUsdPerMTok: 20,
  ...over,
});

const scoresOf = async (externalId: string) =>
  db.db
    .select({ method: itemScores.method, category: itemScores.category, sentiment: itemScores.sentiment, model: itemScores.model })
    .from(itemScores)
    .innerJoin(items, eq(items.id, itemScores.itemId))
    .where(eq(items.externalId, externalId))
    .orderBy(asc(itemScores.method));

describe('analysis pass', () => {
  it('marks cross-site copies, scores originals once and copies their labels', async () => {
    await seed();
    const { classifier, calls } = fakeClassifier();
    const deps: AnalysisDeps = { db: db.db, log, llm: llm(classifier) };
    const first = await runAnalysis(deps);

    // Only the long text counts as a copy; the short reply repeats by chance.
    expect(first.duplicatesMarked).toBe(1);
    const [copy] = await db.db.select({ duplicateOf: items.duplicateOf }).from(items).where(eq(items.externalId, 'ch_a'));
    const [original] = await db.db.select({ id: items.id }).from(items).where(eq(items.externalId, 't1_a'));
    expect(copy!.duplicateOf).toBe(original!.id);

    // Every item gets a rules score; the empty one has no labels.
    expect(first.rulesScored).toBe(6);
    expect(await scoresOf('t1_e')).toEqual([{ method: 'rules', category: null, sentiment: null, model: 'rules-v1' }]);

    // The model sees originals with text, newest first, in one batch: no copy, no empty text.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.map((c) => c.text)).toEqual(['The Mintora app is a joy to use.', 'Thanks, same here!', 'Thanks, same here!', COPIED]);
    expect(first).toMatchObject({ llmScored: 2, llmUnanswered: 2, llmStopped: null, copiedScores: 1 });
    // The copy took the original's model label without a call of its own.
    expect(await scoresOf('ch_a')).toContainEqual({ method: 'llm', category: 'usability', sentiment: 'positive', model: 'fake-model' });

    // Unanswered items keep an empty model row, so they are not paid for again.
    const unanswered = await db.db.execute(sql`select count(*)::int as n from item_scores where method = 'llm' and sentiment is null`);
    expect(unanswered.rows[0]).toEqual({ n: 2 });

    // Spend: (1000 × $4 + 200 × $20) / 1M = $0.008, booked to the client without a source.
    const ledger = await db.db.select().from(costs);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ provider: 'anthropic', unit: 'token', units: 1200, sourceId: null, runId: null });
    expect(ledger[0]!.usd).toBeCloseTo(0.008, 6);

    // A second pass has nothing to do.
    const second = await runAnalysis(deps);
    expect(second).toMatchObject({ duplicatesMarked: 0, rulesScored: 0, llmScored: 0, llmUnanswered: 0, copiedScores: 0 });
    expect(calls).toHaveLength(1);
  });

  it('stops at the monthly model budget and on API errors, leaving the rest for later', async () => {
    await seed();
    const { classifier, calls } = fakeClassifier();
    // One batch of two costs $0.008, which uses the whole budget.
    const budget = await runAnalysis({ db: db.db, log, llm: llm(classifier, { batchSize: 2, monthlyUsd: 0.008 }) });
    expect(budget).toMatchObject({ llmStopped: 'budget', llmScored: 1, llmUnanswered: 1 });
    expect(calls).toHaveLength(1);
    expect((await runAnalysis({ db: db.db, log, llm: llm(classifier, { monthlyUsd: 0.008 }) })).llmStopped).toBe('budget');
    expect(calls).toHaveLength(1);

    await db.db.delete(costs);
    const broken = fakeClassifier({ fail: true });
    const failed = await runAnalysis({ db: db.db, log, llm: llm(broken.classifier) });
    expect(failed).toMatchObject({ llmStopped: 'error', llmScored: 0, llmUnanswered: 0 });
    // Nothing was written for the failed batch, so the next pass sends it again.
    const [{ n }] = (await db.db.execute(sql`select count(*)::int as n from item_scores where method = 'llm'`)).rows as [{ n: number }];
    expect(n).toBe(2);
  });

  it('runs without a model: rules only', async () => {
    await seed();
    const summary = await runAnalysis({ db: db.db, log });
    expect(summary).toMatchObject({ rulesScored: 6, llmScored: 0, llmStopped: null });
  });

  it('re-points copies when the original goes away', async () => {
    await seed();
    const third = await createSource(db, { community: 'de' }, 'forum de', 'threadit');
    await db.db.insert(items).values({ sourceId: third, site: 'threadit', externalId: 't1_z', text: COPIED, textHash: textHash(COPIED) });
    await markDuplicates(db.db);
    // Deleting the source of the original deletes it; the older of the two copies becomes the original.
    const [forum] = await db.db.select({ id: sources.id }).from(sources).where(eq(sources.name, 'forum'));
    await db.db.delete(sources).where(eq(sources.id, forum!.id));
    await markDuplicates(db.db);
    const rows = await db.db.select({ externalId: items.externalId, id: items.id, duplicateOf: items.duplicateOf }).from(items).where(sql`text = ${COPIED}`).orderBy(asc(items.id));
    expect(rows.map((r) => [r.externalId, r.duplicateOf])).toEqual([
      ['ch_a', null],
      ['t1_z', rows[0]!.id],
    ]);
  });
});

describe('evaluation', () => {
  it('scores the rules labels against mock-web ground truth', async () => {
    const mock = await startMockWeb();
    try {
      const sourceId = await createSource(db, { query: 'x' }, 'social', 'chirp');
      const posts = mock.ctx.corpus.chirp.posts.filter((p) => p.text.length > 0).slice(0, 200);
      await db.db.insert(items).values(
        posts.map((p) => ({ sourceId, site: 'chirp' as const, externalId: p.id, text: p.text, textHash: textHash(p.text) })),
      );
      // An item mock-web does not know is left out of the sample.
      await db.db.insert(items).values({ sourceId, site: 'chirp', externalId: 'ch_unknown', text: 'Hello there, nothing to see.', textHash: 'f'.repeat(64) });
      await runAnalysis({ db: db.db, log });

      const result = await runEvaluation(db.db, { truthUrl: `${mock.url}/_admin/truth`, method: 'rules', sampleSize: 1000 });
      expect(result.sampleSize).toBe(200);
      expect(result.categoryAccuracy).toBeGreaterThan(0.85);
      expect(result.sentimentAccuracy).toBeGreaterThan(0.85);
      expect(Object.keys((result.f1ByClass as { sentiment: object }).sentiment).sort()).toEqual(['negative', 'neutral', 'positive']);
      expect(await db.db.select().from(evalResults)).toHaveLength(1);

      await expect(runEvaluation(db.db, { truthUrl: `${mock.url}/_admin/truth`, method: 'llm', sampleSize: 50 })).rejects.toThrow(/No items have a llm score/);
    } finally {
      await mock.close();
    }
  });
});
