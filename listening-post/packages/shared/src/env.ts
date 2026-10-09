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
