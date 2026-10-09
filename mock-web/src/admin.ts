import express, { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from './context.js';
import { HttpError, badRequest, qs } from './lib/http.js';
import { itemCounts } from './seed/generate.js';
import { publish } from './seed/publish.js';
import { TOPICS, type Topic } from './seed/types.js';
import { SITES, type ChaosSettings, type SiteName } from './state.js';

const ChaosPatch = z
  .object({
    errorRate: z.number().min(0).max(1),
    timeoutRate: z.number().min(0).max(1),
    latencyMs: z.number().int().min(0).max(120_000),
    emptyResults: z.boolean(),
    layoutVersion: z.union([z.literal(1), z.literal(2)]),
    botCheckLevel: z.number().int().min(0).max(3),
  })
  .partial()
  .strict();

const topicSchema = z
  .string()
  .transform((t) => t.toLowerCase().replace(/[-_]+/g, ' ').trim())
  .refine((t): t is Topic => (TOPICS as readonly string[]).includes(t), 'unknown topic');

const PublishBody = z.object({
  site: z.enum(['threadit', 'agora', 'ratewell', 'chirp']),
  count: z.number().int().min(1).max(1000),
  topic: topicSchema.optional(),
});

const CreditsBody = z.object({
  site: z.enum(['passgate', 'chirp']),
  balance: z.number().int().min(0),
});

/** Parses with zod, or throws 400 naming the first bad field. */
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.length ? issue.path.join('.') : ((issue as { keys?: string[] } | undefined)?.keys?.[0] ?? 'body');
    throw new HttpError(400, { error: 'bad_request', field, message: issue?.message });
  }
  return result.data;
}

export function adminRouter(ctx: Ctx): Router {
  const r = Router();
  r.use(express.json());

  const snapshot = () => ({
    seed: ctx.config.seed,
    mock_now: new Date(ctx.corpus.now).toISOString(),
    chaos: ctx.state.chaos,
    credits: {
      passgate: { credits_remaining: ctx.state.credits.passgate.remaining, credits_used: ctx.state.credits.passgate.used, requests: ctx.state.credits.passgate.requests },
      chirp: { credits_remaining: ctx.state.credits.chirp.remaining, credits_used: ctx.state.credits.chirp.used, requests: ctx.state.credits.chirp.requests },
    },
    items: itemCounts(ctx.corpus),
  });

  r.get('/state', (_req, res) => {
    res.json(snapshot());
  });

  r.put('/chaos/:site', (req, res) => {
    const site = req.params.site as string;
    if (site !== 'all' && !(SITES as readonly string[]).includes(site)) throw new HttpError(404, { error: 'not_found' });
    const patch = parse(ChaosPatch, req.body);
    if (patch.botCheckLevel !== undefined && site !== 'ratewell' && site !== 'all') throw badRequest('botCheckLevel');
    const targets: SiteName[] = site === 'all' ? [...SITES] : [site as SiteName];
    for (const s of targets) {
      const { botCheckLevel, ...rest } = patch;
      Object.assign(ctx.state.chaos[s], rest as Partial<ChaosSettings>);
      if (botCheckLevel !== undefined && s === 'ratewell') ctx.state.chaos.ratewell.botCheckLevel = botCheckLevel;
    }
    res.json(site === 'all' ? ctx.state.chaos : ctx.state.chaos[site as SiteName]);
  });

  r.post('/publish', (req, res) => {
    const body = parse(PublishBody, req.body);
    const ids = publish(ctx.corpus, ctx.state.publishRng, body.site, body.count, body.topic, ctx.corpusNow());
    res.status(201).json({ site: body.site, ids });
  });

  r.post('/credits', (req, res) => {
    const body = parse(CreditsBody, req.body);
    const account = ctx.state.credits[body.site];
    account.remaining = body.balance;
    res.json({ site: body.site, credits_remaining: account.remaining, credits_used: account.used, requests: account.requests });
  });

  r.get('/truth', (req, res) => {
    const raw = qs(req, 'ids');
    const ids = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0 || ids.length > 500) throw badRequest('ids');
    const out = [];
    for (const id of ids) {
      const t = ctx.corpus.truth.get(id);
      if (t) out.push({ id: t.id, site: t.site, topic: t.topic, category: t.category, sentiment: t.sentiment, country: t.country });
    }
    res.json(out);
  });

  r.get('/requests', (req, res) => {
    const site = qs(req, 'site') || undefined;
    if (site !== undefined && !(SITES as readonly string[]).includes(site)) throw badRequest('site');
    const sinceRaw = qs(req, 'since');
    let since = 0;
    if (sinceRaw) {
      since = /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : Date.parse(sinceRaw);
      if (Number.isNaN(since)) throw badRequest('since');
    }
    const entries = ctx.state.requests.entries.filter((e) => e.ts >= since && (site === undefined || e.site === site));
    const counts: Record<string, Record<string, number>> = {};
    const perSecond = new Map<number, number>();
    for (const e of entries) {
      const bySite = (counts[e.site] ??= {});
      bySite[e.status] = (bySite[e.status] ?? 0) + 1;
      const sec = Math.floor(e.ts / 1000);
      perSecond.set(sec, (perSecond.get(sec) ?? 0) + 1);
    }
    res.json({
      total: entries.length,
      counts,
      peak_rps: Math.max(0, ...perSecond.values()),
      entries: entries.slice(-200).map((e) => ({ ...e, ts: new Date(e.ts).toISOString() })),
    });
  });

  r.post('/reset', (_req, res) => {
    ctx.reset();
    res.json(snapshot());
  });

  r.use(() => {
    throw new HttpError(404, { error: 'not_found' });
  });
  return r;
}
