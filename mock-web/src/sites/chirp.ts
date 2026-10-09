import { Router } from 'express';
import type { Ctx } from '../context.js';
import { iso } from '../lib/format.js';
import { HttpError, badRequest, bearer, intParam, qs } from '../lib/http.js';
import { chaos } from '../middleware/chaos.js';
import { rateLimit } from '../middleware/rateLimit.js';
import type { ChirpPost } from '../seed/types.js';

export function chirpRouter(ctx: Ctx): Router {
  const r = Router();
  const settings = () => ctx.state.chaos.chirp;
  const credits = () => ctx.state.credits.chirp;

  r.use(chaos(ctx, 'chirp'));
  r.use((req, _res, next) => {
    if (bearer(req) !== ctx.config.chirp.key) throw new HttpError(401, { error: 'unauthorized' });
    next();
  });
  r.use(
    rateLimit(ctx, {
      key: () => `chirp:${ctx.config.chirp.key}`,
      limit: () => ctx.config.chirp.rate,
      windowMs: 60_000,
      headers: (res, info) =>
        res.set({
          'x-rate-limit-limit': String(info.limit),
          'x-rate-limit-remaining': String(info.remaining),
          'x-rate-limit-reset': String(Math.ceil((ctx.clock.now() + info.resetMs) / 1000)),
        }),
      reject: (res) => void res.status(429).json({ error: 'rate_limited' }),
    }),
  );

  r.get('/v2/usage', (_req, res) => {
    const c = credits();
    res.json({ credits_remaining: c.remaining, credits_used: c.used, requests: c.requests });
  });

  r.get('/v2/search', (req, res) => {
    const { chirp } = ctx.corpus;
    const query = qs(req, 'query');
    if (!query) throw badRequest('query');
    let country: string | undefined;
    if (req.query.country !== undefined) {
      country = qs(req, 'country')?.toUpperCase();
      if (!country || !/^[A-Z]{2}$/.test(country)) throw badRequest('country');
    }
    const since = timeParam(req.query.since, 'since');
    const until = timeParam(req.query.until, 'until');
    const maxResults = intParam(req, 'max_results', 10, 100, 10);
    let cursor: ChirpPost | undefined;
    if (req.query.next_token !== undefined) {
      const token = qs(req, 'next_token') ?? '';
      cursor = chirp.postById.get(Buffer.from(token, 'base64url').toString('utf8'));
      if (!cursor) throw badRequest('next_token');
    }

    const account = credits();
    if (account.remaining <= 0) throw new HttpError(402, { error: 'quota_exhausted' });

    // A partial page when the balance cannot cover a full one.
    const pageSize = Math.min(maxResults, account.remaining);
    const needle = query.toLowerCase();
    const data: ChirpPost[] = [];
    let more = false;
    if (!settings().emptyResults) {
      for (const p of chirp.posts) {
        if (cursor && !(p.created < cursor.created || (p.created === cursor.created && p.id < cursor.id))) continue;
        if (since !== undefined && p.created < since) continue;
        if (until !== undefined && p.created >= until) continue;
        if (country !== undefined && p.country !== country) continue;
        if (!p.text.toLowerCase().includes(needle)) continue;
        if (data.length === pageSize) {
          more = true;
          break;
        }
        data.push(p);
      }
    }

    const charged = Math.max(1, data.length);
    account.remaining -= charged;
    account.used += charged;
    account.requests += 1;
    const v2 = settings().layoutVersion === 2;
    res.json({
      data: data.map((p) => postJson(p, v2)),
      meta: {
        result_count: data.length,
        next_token: more ? Buffer.from(data[data.length - 1]!.id).toString('base64url') : null,
      },
      usage: { credits_charged: charged, credits_remaining: account.remaining },
    });
  });

  r.use(() => {
    throw new HttpError(404, { error: 'not_found' });
  });
  return r;
}

function timeParam(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) throw badRequest(field);
  return ms;
}

function postJson(p: ChirpPost, v2: boolean) {
  const metrics = { like_count: p.likes, reply_count: p.replies, repost_count: p.reposts };
  const base = { id: p.id, text: p.text, author_id: p.authorId, created_at: iso(p.created), lang: p.lang };
  if (v2) return { ...base, geo: p.country ? { country: p.country } : null, metrics: { public_metrics: metrics } };
  return { ...base, geo: p.country ? { country_code: p.country } : null, public_metrics: metrics };
}
