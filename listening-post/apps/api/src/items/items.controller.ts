import { BadRequestException, Controller, Get, Inject, NotFoundException, Param, ParseIntPipe, Query } from '@nestjs/common';
import { itemScores, items, rawResponses, sources, type Db } from '@lp/db';
import { SITES } from '@lp/shared';
import { and, eq, ilike, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DB } from '../tokens';

const listQuery = z.object({
  site: z.enum(SITES).optional(),
  sourceId: z.uuid().optional(),
  /** ISO country code, or "none" for items without one. */
  country: z
    .string()
    .regex(/^([A-Z]{2}|none)$/)
    .optional(),
  q: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const cursorSchema = z.object({ t: z.iso.datetime({ offset: true }), id: z.number().int() });

/** Newest first by publish time (collection time when a source gives none). */
const sortKey = sql`coalesce(${items.publishedAt}, ${items.collectedAt})`;

@Controller('items')
export class ItemsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Keyset paging: `nextCursor` stays valid while new items arrive, unlike page numbers. */
  @Get()
  async list(@Query(new ZodValidationPipe(listQuery)) q: z.infer<typeof listQuery>) {
    const where: (SQL | undefined)[] = [
      q.site ? eq(items.site, q.site) : undefined,
      q.sourceId ? eq(items.sourceId, q.sourceId) : undefined,
      q.country === 'none' ? isNull(items.country) : q.country ? eq(items.country, q.country) : undefined,
      // Search is literal: % and _ in the query are escaped, not wildcards.
      q.q ? ilike(items.text, `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : undefined,
    ];
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      where.push(sql`(${sortKey}, ${items.id}) < (${c.t}::timestamptz, ${c.id})`);
    }
    const rows = await this.db
      .select({
        id: items.id,
        site: items.site,
        externalId: items.externalId,
        author: items.author,
        text: items.text,
        country: items.country,
        publishedAt: items.publishedAt,
        collectedAt: items.collectedAt,
        sourceId: items.sourceId,
        sourceName: sources.name,
        sortedAt: sql<string>`${sortKey}`.mapWith((v: string | Date) => new Date(v)),
      })
      .from(items)
      .innerJoin(sources, eq(items.sourceId, sources.id))
      .where(and(...where))
      .orderBy(sql`${sortKey} desc`, sql`${items.id} desc`)
      .limit(q.limit + 1);

    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map(({ sortedAt, ...r }) => r),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.sortedAt, last.id) : null,
    };
  }

  /** One item with its scores and the raw response it was parsed from. */
  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    const [row] = await this.db
      .select({ item: items, sourceName: sources.name, raw: { id: rawResponses.id, url: rawResponses.url, runId: rawResponses.runId, fetchedAt: rawResponses.fetchedAt } })
      .from(items)
      .innerJoin(sources, eq(items.sourceId, sources.id))
      .leftJoin(rawResponses, eq(items.rawResponseId, rawResponses.id))
      .where(eq(items.id, id));
    if (!row) throw new NotFoundException({ error: 'not_found' });
    const scores = await this.db.select().from(itemScores).where(eq(itemScores.itemId, id));
    return { ...row.item, sourceName: row.sourceName, raw: row.raw?.id ? row.raw : null, scores };
  }
}

function encodeCursor(t: Date, id: number): string {
  return Buffer.from(JSON.stringify({ t: t.toISOString(), id })).toString('base64url');
}

function decodeCursor(cursor: string): z.infer<typeof cursorSchema> {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new BadRequestException({ error: 'bad_request', field: 'cursor' });
  }
}
