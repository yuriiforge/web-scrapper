import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export const baseEnv = z.object({
  DATABASE_URL: z.url(),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export const apiEnv = baseEnv.extend({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
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
