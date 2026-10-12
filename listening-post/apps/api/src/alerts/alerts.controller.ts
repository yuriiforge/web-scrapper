import { Controller, Get, Inject, Query } from '@nestjs/common';
import { alerts, sources, type Db } from '@lp/db';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DB } from '../tokens';

const listQuery = z.object({
  /** "true" for open alerts only (the default), "false" for resolved ones. */
  open: z.enum(['true', 'false']).default('true'),
  sourceId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** Alerts the worker's monitor opens and resolves; newest first. */
@Controller('alerts')
export class AlertsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  list(@Query(new ZodValidationPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.db
      .select({
        id: alerts.id,
        sourceId: alerts.sourceId,
        sourceName: sources.name,
        kind: alerts.kind,
        message: alerts.message,
        openedAt: alerts.openedAt,
        resolvedAt: alerts.resolvedAt,
      })
      .from(alerts)
      .leftJoin(sources, eq(alerts.sourceId, sources.id))
      .where(
        and(
          q.open === 'true' ? isNull(alerts.resolvedAt) : isNotNull(alerts.resolvedAt),
          q.sourceId ? eq(alerts.sourceId, q.sourceId) : undefined,
        ),
      )
      .orderBy(desc(alerts.openedAt))
      .limit(q.limit);
  }
}
