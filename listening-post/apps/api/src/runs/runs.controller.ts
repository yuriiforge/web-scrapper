import { ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { rawResponses, runs, sources, type Db } from '@lp/db';
import { listRunsQuery } from '@lp/shared';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DB } from '../tokens';

const RUN_COLUMNS = {
  id: runs.id,
  sourceId: runs.sourceId,
  sourceName: sources.name,
  site: sources.site,
  trigger: runs.trigger,
  status: runs.status,
  createdAt: runs.createdAt,
  startedAt: runs.startedAt,
  finishedAt: runs.finishedAt,
  pages: runs.pages,
  requests: runs.requests,
  itemsFound: runs.itemsFound,
  itemsNew: runs.itemsNew,
  errorClass: runs.errorClass,
  errorMessage: runs.errorMessage,
  strategy: runs.strategy,
};

@Controller('runs')
export class RunsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Newest first. */
  @Get()
  list(@Query(new ZodValidationPipe(listRunsQuery)) q: z.infer<typeof listRunsQuery>) {
    return this.db
      .select(RUN_COLUMNS)
      .from(runs)
      .innerJoin(sources, eq(runs.sourceId, sources.id))
      .where(and(q.sourceId ? eq(runs.sourceId, q.sourceId) : undefined, q.status ? eq(runs.status, q.status) : undefined))
      .orderBy(desc(runs.createdAt))
      .limit(q.limit);
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const [row] = await this.db.select(RUN_COLUMNS).from(runs).innerJoin(sources, eq(runs.sourceId, sources.id)).where(eq(runs.id, id));
    if (!row) throw new NotFoundException({ error: 'not_found' });
    return row;
  }

  /** Stops a queued or running run; the worker checks between pages and keeps what it saved. */
  @Post(':id/cancel')
  async cancel(@Param('id', ParseUUIDPipe) id: string) {
    const [row] = await this.db
      .update(runs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(runs.id, id), inArray(runs.status, ['queued', 'running'])))
      .returning({ id: runs.id, status: runs.status });
    if (row) return row;
    await this.get(id); // 404 if it does not exist
    throw new ConflictException({ error: 'not_cancellable' });
  }

  /** Raw responses a run stored, without bodies, for debugging a parser. */
  @Get(':id/raw')
  async raw(@Param('id', ParseUUIDPipe) id: string) {
    await this.get(id);
    return this.db
      .select({
        id: rawResponses.id,
        url: rawResponses.url,
        httpStatus: rawResponses.httpStatus,
        sha256: rawResponses.sha256,
        bodyStored: rawResponses.body,
        fetchedAt: rawResponses.fetchedAt,
        expiresAt: rawResponses.expiresAt,
      })
      .from(rawResponses)
      .where(eq(rawResponses.runId, id))
      .orderBy(asc(rawResponses.id))
      .then((rows) => rows.map(({ bodyStored, ...r }) => ({ ...r, bodyStored: bodyStored !== null })));
  }
}
