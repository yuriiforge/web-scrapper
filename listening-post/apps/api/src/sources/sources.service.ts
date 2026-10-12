import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { checkpoints, items, runs, sources, type Db } from '@lp/db';
import { sendCollect, type PgBoss } from '@lp/queue';
import { SOURCE_CONFIGS, type CreateSource, type UpdateSource } from '@lp/shared';
import { asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { PG_FOREIGN_KEY_VIOLATION, pgCode } from '../common/pg-errors';
import { DB, QUEUE } from '../tokens';

@Injectable()
export class SourcesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(QUEUE) private readonly boss: PgBoss,
  ) {}

  /** Sources with their latest run and item count, for the sources table. */
  async list(clientId?: string) {
    const rows = await this.db
      .select()
      .from(sources)
      .where(clientId ? eq(sources.clientId, clientId) : undefined)
      .orderBy(asc(sources.name));
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);

    const latest = await this.db
      .selectDistinctOn([runs.sourceId], {
        sourceId: runs.sourceId,
        id: runs.id,
        status: runs.status,
        createdAt: runs.createdAt,
        finishedAt: runs.finishedAt,
        itemsNew: runs.itemsNew,
        errorClass: runs.errorClass,
      })
      .from(runs)
      .where(inArray(runs.sourceId, ids))
      .orderBy(runs.sourceId, desc(runs.createdAt));
    const counts = await this.db
      .select({ sourceId: items.sourceId, n: count() })
      .from(items)
      .where(inArray(items.sourceId, ids))
      .groupBy(items.sourceId);

    const lastRun = new Map(latest.map(({ sourceId, ...run }) => [sourceId, run]));
    const itemCount = new Map(counts.map((c) => [c.sourceId, c.n]));
    return rows.map((s) => ({ ...s, lastRun: lastRun.get(s.id) ?? null, itemCount: itemCount.get(s.id) ?? 0 }));
  }

  async get(id: string) {
    const [row] = await this.db
      .select({ source: sources, checkpoint: checkpoints })
      .from(sources)
      .leftJoin(checkpoints, eq(checkpoints.sourceId, sources.id))
      .where(eq(sources.id, id));
    if (!row) throw new NotFoundException({ error: 'not_found' });
    return { ...row.source, checkpoint: row.checkpoint };
  }

  async create(input: CreateSource) {
    try {
      const [row] = await this.db.insert(sources).values(input).returning();
      return row;
    } catch (err) {
      if (pgCode(err) === PG_FOREIGN_KEY_VIOLATION) throw new BadRequestException({ error: 'bad_request', field: 'clientId', message: 'unknown client' });
      throw err;
    }
  }

  async update(id: string, patch: UpdateSource) {
    const current = await this.get(id);
    let config = patch.config;
    if (config !== undefined) {
      // A source's site never changes, so its config is checked against that site's schema.
      const schema = SOURCE_CONFIGS[current.site as keyof typeof SOURCE_CONFIGS];
      const parsed = schema.safeParse(config);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new BadRequestException({ error: 'bad_request', field: ['config', ...(issue?.path ?? [])].join('.'), message: issue?.message });
      }
      config = parsed.data;
    }
    const [row] = await this.db
      .update(sources)
      .set({ ...patch, config, updatedAt: new Date() })
      .where(eq(sources.id, id))
      .returning();
    return row;
  }

  async remove(id: string): Promise<void> {
    const deleted = await this.db.delete(sources).where(eq(sources.id, id)).returning({ id: sources.id });
    if (deleted.length === 0) throw new NotFoundException({ error: 'not_found' });
  }

  /** Creates a queued run and hands it to the worker. Runs of one source never overlap. */
  async runNow(id: string) {
    const source = await this.get(id);
    if (!source.enabled) throw new ConflictException({ error: 'source_disabled' });
    const [run] = await this.db.insert(runs).values({ sourceId: id, trigger: 'manual' }).returning();
    await sendCollect(this.boss, { sourceId: id, runId: run!.id, trigger: 'manual' });
    return run!;
  }

  /**
   * Queues a re-parse: the worker re-runs the parser over the source's stored raw responses, with
   * no new requests. For after a parser fix.
   */
  async reparse(id: string) {
    await this.get(id);
    const [run] = await this.db.insert(runs).values({ sourceId: id, trigger: 'reparse' }).returning();
    await sendCollect(this.boss, { sourceId: id, runId: run!.id, trigger: 'reparse' });
    return run!;
  }

  /** Counts per run status for one source, for the source detail page. */
  async runStats(id: string) {
    return this.db
      .select({ status: runs.status, n: count() })
      .from(runs)
      .where(eq(runs.sourceId, id))
      .groupBy(runs.status)
      .orderBy(sql`2 desc`);
  }
}
