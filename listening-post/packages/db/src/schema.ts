import {
  CATEGORIES,
  ERROR_CLASSES,
  RUN_STATUSES,
  RUN_TRIGGERS,
  SCORE_METHODS,
  SENTIMENTS,
  SITES,
  STRATEGIES,
} from '@lp/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const siteEnum = pgEnum('site', SITES);
export const strategyEnum = pgEnum('strategy', STRATEGIES);
export const runStatusEnum = pgEnum('run_status', RUN_STATUSES);
export const runTriggerEnum = pgEnum('run_trigger', RUN_TRIGGERS);
export const errorClassEnum = pgEnum('error_class', ERROR_CLASSES);
export const scoreMethodEnum = pgEnum('score_method', SCORE_METHODS);
export const categoryEnum = pgEnum('category', CATEGORIES);
export const sentimentEnum = pgEnum('sentiment', SENTIMENTS);

/** The tenants that data and costs are split by. */
export const clients = pgTable('clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  createdAt: createdAt(),
});

/** One thing to collect, e.g. "Threadit community gb for client A". */
export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    site: siteEnum('site').notNull(),
    strategy: strategyEnum('strategy').notNull(),
    config: jsonb('config').notNull().default({}),
    /** Cron expression; null means manual runs only. */
    schedule: text('schedule'),
    enabled: boolean('enabled').notNull().default(true),
    budgetUsdMonth: numeric('budget_usd_month', { precision: 12, scale: 2, mode: 'number' }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sources_client_idx').on(t.clientId)],
);

/** Where the next incremental run of a source starts. */
export const checkpoints = pgTable('checkpoints', {
  sourceId: uuid('source_id')
    .primaryKey()
    .references(() => sources.id, { onDelete: 'cascade' }),
  cursor: jsonb('cursor'),
  /** Lowest strategy that worked last time (the escalation ladder). */
  escalationStep: strategyEnum('escalation_step'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    trigger: runTriggerEnum('trigger').notNull(),
    status: runStatusEnum('status').notNull().default('queued'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    pages: integer('pages').notNull().default(0),
    /** Every HTTP attempt, including retries, 304s and token requests: the unit providers bill by. */
    requests: integer('requests').notNull().default(0),
    /**
     * Entries the site listed (posts on listing pages, topics, reviews), or null when no listing came
     * back (e.g. a 304). An empty listing is a better sign of trouble than no new items.
     */
    listed: integer('listed'),
    itemsFound: integer('items_found').notNull().default(0),
    itemsNew: integer('items_new').notNull().default(0),
    errorClass: errorClassEnum('error_class'),
    errorMessage: text('error_message'),
    /** The escalation-ladder step the run ended on (e.g. it started on html and needed the unblocker). */
    strategy: strategyEnum('strategy'),
    createdAt: createdAt(),
  },
  (t) => [index('runs_source_created_idx').on(t.sourceId, t.createdAt), index('runs_status_idx').on(t.status)],
);

/** Every response, saved before parsing so it can be re-parsed later. Kept for a limited time. */
export const rawResponses = pgTable(
  'raw_responses',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    httpStatus: integer('http_status').notNull(),
    headers: jsonb('headers').notNull().default({}),
    /** Compressed body; null when identical to the previous response for the same URL. */
    body: bytea('body'),
    sha256: char('sha256', { length: 64 }).notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('raw_run_idx').on(t.runId), index('raw_expires_idx').on(t.expiresAt), index('raw_url_idx').on(t.url, t.fetchedAt)],
);

/** Parsed, normalised items from every site. */
export const items = pgTable(
  'items',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    site: siteEnum('site').notNull(),
    externalId: text('external_id').notNull(),
    author: text('author'),
    text: text('text').notNull(),
    /** SHA-256 of normalised text, for cross-site duplicates. */
    textHash: char('text_hash', { length: 64 }).notNull(),
    duplicateOf: bigint('duplicate_of', { mode: 'number' }),
    /** ISO 3166-1 alpha-2; null when the source does not say. */
    country: char('country', { length: 2 }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    collectedAt: timestamp('collected_at', { withTimezone: true }).notNull().defaultNow(),
    rawResponseId: bigint('raw_response_id', { mode: 'number' }).references(() => rawResponses.id, { onDelete: 'set null' }),
    /** Site-specific fields worth keeping, e.g. a review's rating or a post's score. */
    meta: jsonb('meta').notNull().default({}),
  },
  (t) => [
    uniqueIndex('items_site_external_uq').on(t.site, t.externalId),
    index('items_text_hash_idx').on(t.textHash),
    index('items_source_published_idx').on(t.sourceId, t.publishedAt),
  ],
);

/** One score per item per method, so methods can be compared. */
export const itemScores = pgTable(
  'item_scores',
  {
    itemId: bigint('item_id', { mode: 'number' })
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    method: scoreMethodEnum('method').notNull(),
    category: categoryEnum('category'),
    sentiment: sentimentEnum('sentiment'),
    confidence: real('confidence'),
    model: text('model'),
    scoredAt: timestamp('scored_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.method] })],
);

/** One row per billable event. */
export const costs = pgTable(
  'costs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').references(() => sources.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    units: numeric('units', { precision: 14, scale: 4, mode: 'number' }).notNull(),
    unit: text('unit').notNull(),
    usd: numeric('usd', { precision: 12, scale: 6, mode: 'number' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('costs_client_created_idx').on(t.clientId, t.createdAt), index('costs_source_created_idx').on(t.sourceId, t.createdAt)],
);

export const alerts = pgTable(
  'alerts',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sourceId: uuid('source_id').references(() => sources.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    message: text('message').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  // At most one open alert per source and kind.
  (t) => [uniqueIndex('alerts_open_uq').on(t.sourceId, t.kind).where(sql`${t.resolvedAt} is null`)],
);

/** Scoring accuracy against mock-web's ground truth. */
export const evalResults = pgTable('eval_results', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  method: scoreMethodEnum('method').notNull(),
  sampleSize: integer('sample_size').notNull(),
  categoryAccuracy: real('category_accuracy').notNull(),
  sentimentAccuracy: real('sentiment_accuracy').notNull(),
  f1ByClass: jsonb('f1_by_class').notNull(),
  createdAt: createdAt(),
});

/** Liveness of worker processes, read by the API health check. */
export const workerHeartbeats = pgTable('worker_heartbeats', {
  workerId: text('worker_id').primaryKey(),
  lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
});

/** Token buckets for outbound rate limits, shared by all worker processes. */
export const rateBuckets = pgTable('rate_buckets', {
  key: text('key').primaryKey(),
  tokens: real('tokens').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Validators for conditional requests (If-None-Match), one row per URL. Written only when a run
 * succeeds, so a failed run never leaves an ETag that would hide content it did not store.
 */
export const httpCache = pgTable('http_cache', {
  url: text('url').primaryKey(),
  etag: text('etag').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
