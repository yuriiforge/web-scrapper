import { z } from 'zod';

const count = (def: number, min = 1) => z.coerce.number().int().min(min).default(def);

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  SEED: z.coerce.number().int().default(42),
  MOCK_NOW: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'must be an ISO timestamp')
    .optional(),
  THREADIT_CLIENT_ID: z.string().min(1).default('dev-id'),
  THREADIT_CLIENT_SECRET: z.string().min(1).default('dev-secret'),
  THREADIT_TOKEN_TTL: count(300),
  THREADIT_RATE: count(60),
  AGORA_RATE: count(10),
  RATEWELL_RATE: count(30),
  PASSGATE_KEY: z.string().min(1).default('pg-dev-key'),
  PASSGATE_CREDITS: count(2000, 0),
  CHIRP_KEY: z.string().min(1).default('chirp-dev-key'),
  CHIRP_CREDITS: count(10000, 0),
  CHIRP_RATE: count(30),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface Config {
  port: number;
  seed: number;
  /** Epoch ms treated as "now" when dating items; undefined means boot time. */
  mockNow: number | undefined;
  threadit: { clientId: string; clientSecret: string; tokenTtl: number; rate: number };
  agora: { rate: number };
  ratewell: { rate: number };
  passgate: { key: string; credits: number };
  chirp: { key: string; credits: number; rate: number };
  logLevel: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Treat empty strings (common in compose files) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    seed: e.SEED,
    mockNow: e.MOCK_NOW === undefined ? undefined : Date.parse(e.MOCK_NOW),
    threadit: {
      clientId: e.THREADIT_CLIENT_ID,
      clientSecret: e.THREADIT_CLIENT_SECRET,
      tokenTtl: e.THREADIT_TOKEN_TTL,
      rate: e.THREADIT_RATE,
    },
    agora: { rate: e.AGORA_RATE },
    ratewell: { rate: e.RATEWELL_RATE },
    passgate: { key: e.PASSGATE_KEY, credits: e.PASSGATE_CREDITS },
    chirp: { key: e.CHIRP_KEY, credits: e.CHIRP_CREDITS, rate: e.CHIRP_RATE },
    logLevel: e.LOG_LEVEL,
  };
}
