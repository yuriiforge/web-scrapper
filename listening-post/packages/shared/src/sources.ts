import { z } from 'zod';
import { SITES, STRATEGIES, type Site } from './domain';

// Per-site source configuration. The API validates it on write; collectors parse it again on run.

export const threaditConfig = z.object({
  /** Community name, e.g. "gb" or "electric_cars". */
  community: z.string().regex(/^[a-z0-9_]+$/, 'lower-case letters, digits and _ only'),
  /** Posts per listing request, 1 to 100. */
  pageSize: z.number().int().min(1).max(100).default(100),
  /** Also collect comments for each new post. */
  includeComments: z.boolean().default(true),
  /** Stop after this many listing pages; unset means until the checkpoint or the end. */
  maxPages: z.number().int().min(1).optional(),
  /** Overrides the collector's default request rate for this source. */
  ratePerMinute: z.number().int().min(1).optional(),
});
export type ThreaditConfig = z.infer<typeof threaditConfig>;

export const agoraConfig = z.object({
  /** Category slug, e.g. "meal-kits"; unset collects every category through the latest-activity listing. */
  category: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'lower-case letters, digits and - only')
    .optional(),
  /** "json" uses the hidden .json endpoints (smaller, steadier); "html" parses the pages people see. */
  format: z.enum(['json', 'html']).default('json'),
  /** Stop after this many changed topics in one run. */
  maxTopics: z.number().int().min(1).optional(),
  /** Never faster than robots.txt Crawl-delay allows, whatever is set here. */
  ratePerMinute: z.number().int().min(1).optional(),
});
export type AgoraConfig = z.infer<typeof agoraConfig>;

/** Ratewell's escalation ladder, cheapest first: plain HTTP, a real browser, then the paid unblocker. */
export const RATEWELL_LADDER = ['html', 'browser', 'unblocker'] as const;
export type RatewellStep = (typeof RATEWELL_LADDER)[number];

export const ratewellConfig = z.object({
  /** Company slug, e.g. "voltra-motors". */
  company: z.string().regex(/^[a-z0-9-]+$/, 'lower-case letters, digits and - only'),
  /** Steps this source may use, in ladder order. Leave out "unblocker" to never pay for a page. */
  strategies: z
    .array(z.enum(RATEWELL_LADDER))
    .min(1)
    .default([...RATEWELL_LADDER])
    .transform((steps) => RATEWELL_LADDER.filter((s) => steps.includes(s))),
  /** Stop after this many review pages (20 reviews each). */
  maxPages: z.number().int().min(1).optional(),
  /** Data requests per minute; the site blocks a session for 5 minutes above 30. Default 20. */
  ratePerMinute: z.number().int().min(1).optional(),
});
export type RatewellConfig = z.infer<typeof ratewellConfig>;

/** Sites whose collectors exist so far. Others are added in later build steps. */
export const SOURCE_CONFIGS = {
  threadit: threaditConfig,
  agora: agoraConfig,
  ratewell: ratewellConfig,
} as const satisfies Partial<Record<Site, z.ZodType>>;

export const SUPPORTED_SITES = Object.keys(SOURCE_CONFIGS) as (keyof typeof SOURCE_CONFIGS)[];

/** Five-field cron expression, e.g. "*\/15 * * * *". Checked loosely here; pg-boss rejects anything it cannot parse. */
const cron = z.string().regex(/^(\S+\s+){4}\S+$/, 'five-field cron expression');

const sourceBase = z.object({
  clientId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  strategy: z.enum(STRATEGIES).default('api'),
  schedule: cron.nullable().default(null),
  enabled: z.boolean().default(true),
  budgetUsdMonth: z.number().nonnegative().nullable().default(null),
});

export const createSourceSchema = z.discriminatedUnion('site', [
  sourceBase.extend({ site: z.literal('threadit'), config: threaditConfig }),
  sourceBase.extend({ site: z.literal('agora'), config: agoraConfig, strategy: z.enum(STRATEGIES).default('html') }),
  sourceBase.extend({ site: z.literal('ratewell'), config: ratewellConfig, strategy: z.enum(STRATEGIES).default('html') }),
]);
export type CreateSource = z.infer<typeof createSourceSchema>;

/** Partial update. `config` is re-validated against the source's site by the API. */
export const updateSourceSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    strategy: z.enum(STRATEGIES),
    schedule: cron.nullable(),
    enabled: z.boolean(),
    budgetUsdMonth: z.number().nonnegative().nullable(),
    config: z.record(z.string(), z.unknown()),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'at least one field');
export type UpdateSource = z.infer<typeof updateSourceSchema>;

export const createClientSchema = z.object({ name: z.string().trim().min(1).max(200) });

export const listRunsQuery = z.object({
  sourceId: z.uuid().optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function isSite(value: string): value is Site {
  return (SITES as readonly string[]).includes(value);
}
