import { costs, itemScores, items, sources, type Db } from '@lp/db';
import { and, asc, desc, eq, gte, isNull, sql, sum } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Classifier } from './llm';
import { scoreRules } from './rules';

/** Texts shorter than this ("Thanks!", "Same here") repeat by chance, so they are never marked as copies. */
export const MIN_DUPLICATE_CHARS = 40;
/** Items the rules scorer takes per query; it loops until nothing is left. */
const RULES_BATCH = 2000;

export interface LlmSettings {
  classifier: Classifier;
  /** Items sent to the model per pass, newest first. */
  maxItemsPerPass: number;
  /** Items per request. */
  batchSize: number;
  /** Model spend per calendar month (UTC) across all clients; the pass stops when it is reached. */
  monthlyUsd: number;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export interface AnalysisDeps {
  db: Db;
  log: Logger;
  /** Unset: only the free rules scorer runs. */
  llm?: LlmSettings;
  now?: () => Date;
}

export interface AnalysisSummary {
  duplicatesMarked: number;
  rulesScored: number;
  llmScored: number;
  llmUnanswered: number;
  llmUsd: number;
  llmStopped: 'budget' | 'error' | null;
  copiedScores: number;
}

/**
 * Points every copy of a text at the first item collected with it (`duplicate_of`), across sites.
 * Re-points copies when the original was deleted. Returns how many items changed.
 */
export async function markDuplicates(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    const firsts = sql`(select text_hash, min(id) as id from ${items} where length(text) >= ${MIN_DUPLICATE_CHARS} group by text_hash having count(*) > 1)`;
    // Originals never point anywhere (an older original may have been deleted).
    await tx.execute(sql`update ${items} i set duplicate_of = null from ${firsts} f where i.id = f.id and i.duplicate_of is not null`);
    // Copies whose original is gone and that have no other copy left.
    await tx.execute(
      sql`update ${items} i set duplicate_of = null where i.duplicate_of is not null and not exists (select 1 from ${items} o where o.id = i.duplicate_of)`,
    );
    const marked = await tx.execute(sql`
      update ${items} i set duplicate_of = f.id from ${firsts} f
      where i.text_hash = f.text_hash and i.id <> f.id and length(i.text) >= ${MIN_DUPLICATE_CHARS}
        and i.duplicate_of is distinct from f.id`);
    return marked.rowCount ?? 0;
  });
}

/** Scores every item that has no rules score yet. */
export async function scoreWithRules(db: Db): Promise<number> {
  let total = 0;
  for (;;) {
    const batch = await db
      .select({ id: items.id, text: items.text })
      .from(items)
      .where(sql`not exists (select 1 from ${itemScores} s where s.item_id = ${items.id} and s.method = 'rules')`)
      .orderBy(asc(items.id))
      .limit(RULES_BATCH);
    if (batch.length === 0) return total;
    await db
      .insert(itemScores)
      .values(batch.map((b) => ({ itemId: b.id, method: 'rules' as const, ...scoreRules(b.text), model: 'rules-v1' })))
      .onConflictDoNothing();
    total += batch.length;
    if (batch.length < RULES_BATCH) return total;
  }
}

/** Model spend this calendar month (UTC). */
export async function llmSpendThisMonth(db: Db, now: Date): Promise<number> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await db
    .select({ usd: sum(costs.usd).mapWith(Number) })
    .from(costs)
    .where(and(eq(costs.provider, 'anthropic'), gte(costs.createdAt, monthStart)));
  return row?.usd ?? 0;
}

/**
 * Sends originals (not copies) without a model score to the model, newest first, in batches.
 * Every item sent gets a row, so nothing is paid for twice: unanswered items (refusal, invalid
 * output) get empty labels and the rules score stands in for them. API errors stop the pass and
 * leave that batch for the next one. Spend is booked per client, without a source, so it does not
 * eat into collection budgets.
 */
export async function scoreWithLlm(deps: AnalysisDeps): Promise<Pick<AnalysisSummary, 'llmScored' | 'llmUnanswered' | 'llmUsd' | 'llmStopped'>> {
  const out = { llmScored: 0, llmUnanswered: 0, llmUsd: 0, llmStopped: null as AnalysisSummary['llmStopped'] };
  const { db, log, llm } = deps;
  if (!llm) return out;
  const now = deps.now ?? (() => new Date());

  let spent = await llmSpendThisMonth(db, now());
  if (spent >= llm.monthlyUsd) {
    out.llmStopped = 'budget';
    return out;
  }
  const candidates = await db
    .select({ id: items.id, text: items.text, clientId: sources.clientId })
    .from(items)
    .innerJoin(sources, eq(items.sourceId, sources.id))
    .where(
      and(
        isNull(items.duplicateOf),
        sql`length(${items.text}) > 0`,
        sql`not exists (select 1 from ${itemScores} s where s.item_id = ${items.id} and s.method = 'llm')`,
      ),
    )
    .orderBy(sql`${items.publishedAt} desc nulls last`, desc(items.id))
    .limit(llm.maxItemsPerPass);

  for (let i = 0; i < candidates.length; i += llm.batchSize) {
    if (spent >= llm.monthlyUsd) {
      out.llmStopped = 'budget';
      break;
    }
    const batch = candidates.slice(i, i + llm.batchSize);
    let result;
    try {
      result = await llm.classifier.classify(batch.map((b, n) => ({ key: `i${n}`, text: b.text })));
    } catch (err) {
      log.error({ err }, 'model request failed; the rest waits for the next pass');
      out.llmStopped = 'error';
      break;
    }
    const usd = (result.inputTokens * llm.inputUsdPerMTok + result.outputTokens * llm.outputUsdPerMTok) / 1_000_000;
    const tokens = result.inputTokens + result.outputTokens;

    await db.transaction(async (tx) => {
      await tx
        .insert(itemScores)
        .values(
          batch.map((b, n) => {
            const s = result.scores.get(`i${n}`);
            return { itemId: b.id, method: 'llm' as const, category: s?.category ?? null, sentiment: s?.sentiment ?? null, confidence: s?.confidence ?? 0, model: result.model };
          }),
        )
        .onConflictDoNothing();
      // One cost row per client, split by its share of the batch.
      const perClient = new Map<string, number>();
      for (const b of batch) perClient.set(b.clientId, (perClient.get(b.clientId) ?? 0) + 1);
      if (usd > 0) {
        await tx.insert(costs).values(
          [...perClient].map(([clientId, n]) => ({
            clientId,
            provider: 'anthropic',
            unit: 'token',
            units: Math.round((tokens * n) / batch.length),
            usd: (usd * n) / batch.length,
          })),
        );
      }
    });

    spent += usd;
    out.llmUsd += usd;
    out.llmScored += result.scores.size;
    out.llmUnanswered += batch.length - result.scores.size;
    if (result.scores.size < batch.length) {
      log.warn({ stopReason: result.stopReason, sent: batch.length, answered: result.scores.size }, 'model left items unlabelled');
    }
  }
  return out;
}

/** Copies take their original's scores, so a repost costs no model call. */
export async function copyDuplicateScores(db: Db): Promise<number> {
  const res = await db.execute(sql`
    insert into ${itemScores} (item_id, method, category, sentiment, confidence, model)
    select d.id, s.method, s.category, s.sentiment, s.confidence, s.model
    from ${items} d join ${itemScores} s on s.item_id = d.duplicate_of
    where d.duplicate_of is not null
    on conflict do nothing`);
  return res.rowCount ?? 0;
}

/** One analysis pass: duplicates, then the free scorer, then the model, then copies. */
export async function runAnalysis(deps: AnalysisDeps): Promise<AnalysisSummary> {
  const duplicatesMarked = await markDuplicates(deps.db);
  const rulesScored = await scoreWithRules(deps.db);
  const llm = await scoreWithLlm(deps);
  const copiedScores = await copyDuplicateScores(deps.db);
  const summary = { duplicatesMarked, rulesScored, ...llm, copiedScores };
  if (duplicatesMarked || rulesScored || llm.llmScored || llm.llmUnanswered || copiedScores) deps.log.info(summary, 'analysis pass');
  return summary;
}
