import { BadGatewayException, Body, Controller, Get, Inject, Post, Query, UnprocessableEntityException } from '@nestjs/common';
import { NothingToEvaluateError, TruthUnavailableError, llmSpendThisMonth, runEvaluation } from '@lp/analysis';
import { evalResults, itemScores, items, type Db } from '@lp/db';
import { SCORE_METHODS } from '@lp/shared';
import { count, desc, eq, max, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { ApiEnv } from '../config';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { API_ENV, DB } from '../tokens';

const evaluateBody = z.object({
  method: z.enum(SCORE_METHODS),
  sampleSize: z.number().int().min(20).max(2000).default(500),
});

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(20) });

/** Scoring coverage, duplicates and accuracy against ground truth. */
@Controller('analysis')
export class AnalysisController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  @Get()
  async status() {
    const original = alias(items, 'original');
    const [totals] = await this.db
      .select({
        items: count(),
        duplicates: count(original.id),
        // A copy whose original was collected from another site: the same text posted in two places.
        crossSite: sql<number>`count(*) filter (where ${original.site} <> ${items.site})`.mapWith(Number),
      })
      .from(items)
      .leftJoin(original, eq(original.id, items.duplicateOf));
    const scored = await this.db
      .select({
        method: itemScores.method,
        n: count(),
        unlabelled: sql<number>`count(*) filter (where ${itemScores.sentiment} is null)`.mapWith(Number),
        latest: max(itemScores.scoredAt),
      })
      .from(itemScores)
      .groupBy(itemScores.method);
    const byMethod = Object.fromEntries(
      SCORE_METHODS.map((m) => {
        const row = scored.find((s) => s.method === m);
        return [m, { scored: row?.n ?? 0, unlabelled: row?.unlabelled ?? 0, latestAt: row?.latest ?? null }];
      }),
    );
    return {
      items: totals?.items ?? 0,
      duplicates: totals?.duplicates ?? 0,
      crossSiteDuplicates: totals?.crossSite ?? 0,
      methods: byMethod,
      llmSpendMonthUsd: await llmSpendThisMonth(this.db, new Date()),
    };
  }

  @Get('evaluations')
  evaluations(@Query(new ZodValidationPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.db.select().from(evalResults).orderBy(desc(evalResults.id)).limit(q.limit);
  }

  /** Compares a random sample of one method's labels with mock-web's ground truth; takes a second or two. */
  @Post('evaluations')
  async evaluate(@Body(new ZodValidationPipe(evaluateBody)) body: z.infer<typeof evaluateBody>) {
    try {
      return await runEvaluation(this.db, { truthUrl: this.env.TRUTH_URL, ...body });
    } catch (err) {
      if (err instanceof NothingToEvaluateError) throw new UnprocessableEntityException({ error: 'nothing_to_evaluate', message: err.message });
      if (err instanceof TruthUnavailableError) throw new BadGatewayException({ error: 'truth_unavailable', message: err.message });
      throw err;
    }
  }
}
