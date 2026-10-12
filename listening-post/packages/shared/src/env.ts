import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export const baseEnv = z.object({
  DATABASE_URL: z.url(),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export const apiEnv = baseEnv.extend({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  /** Bearer token every /api request must carry. Unset turns the check off (local development only). */
  API_TOKEN: z.string().min(16, 'at least 16 characters').optional(),
  /** Ground-truth labels for evaluating the scorers (mock-web's admin endpoint). */
  TRUTH_URL: z.url().default('http://localhost:4000/_admin/truth'),
});

export const workerEnv = baseEnv.extend({
  SOURCE_BASE_URL: z.url().default('http://localhost:4000'),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).default(10_000),
  HEARTBEAT_FILE: z.string().default('/tmp/worker-heartbeat'),
  /** Collection runs processed at the same time by this worker. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  /** How long raw responses are kept before the retention job deletes them. */
  RAW_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  /** Outbound requests per minute per source host, unless a source sets its own. */
  DEFAULT_RATE_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  THREADIT_CLIENT_ID: z.string().min(1).default('dev-id'),
  THREADIT_CLIENT_SECRET: z.string().min(1).default('dev-secret'),
  /** PassGate, the paid unblocker; defaults to the same host as the sources (mock-web). */
  PASSGATE_URL: z.url().optional(),
  PASSGATE_KEY: z.string().min(1).default('pg-dev-key'),
  /** Price of one PassGate credit in USD, for the cost ledger. */
  PASSGATE_CREDIT_USD: z.coerce.number().nonnegative().default(0.002),
  /** Price of one minute of browser time in USD (compute for a hosted browser). */
  BROWSER_MINUTE_USD: z.coerce.number().nonnegative().default(0.01),
  CHIRP_KEY: z.string().min(1).default('chirp-dev-key'),
  /** Price of one Chirp credit (one post returned) in USD. */
  CHIRP_POST_USD: z.coerce.number().nonnegative().default(0.0005),
  /** Each alert opened or resolved is POSTed here as JSON, when set (e.g. a Slack incoming webhook relay). */
  ALERT_WEBHOOK_URL: z.url().optional(),
  /** Turns on the Claude scorer. Unset: only the free rules scorer runs. */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  LLM_MODEL: z.string().min(1).default('claude-opus-5-5'),
  /** Items sent to the model per analysis pass (one pass a minute), newest first. */
  LLM_MAX_ITEMS_PER_PASS: z.coerce.number().int().min(1).default(100),
  LLM_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
  /** Model spend cap per calendar month (UTC), all clients together. */
  LLM_MONTHLY_USD: z.coerce.number().nonnegative().default(5),
  /** Model prices per million tokens, for the cost ledger; defaults are Claude Opus 5.5's. */
  LLM_INPUT_USD_PER_MTOK: z.coerce.number().nonnegative().default(4),
  LLM_OUTPUT_USD_PER_MTOK: z.coerce.number().nonnegative().default(20),
  BROWSER_HEADLESS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

/** Validates env against a schema; exits with a readable message on failure. Empty strings count as unset. */
export function loadEnv<S extends z.ZodType>(schema: S, env: Record<string, string | undefined> = process.env): z.infer<S> {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
