import { Router } from 'express';
import type { Ctx } from '../context.js';
import { HttpError, badRequest, bearer, intParam, qs } from '../lib/http.js';
import { chaos } from '../middleware/chaos.js';
import { INTERNAL_HEADER } from '../middleware/requestLog.js';
import { RENDER_HEADER } from './ratewell.js';

const RAW_COST = 1;
const RENDER_COST = 5;
const TARGET_TIMEOUT_MS = 40_000;
const COMPANY_PAGE = /^\/ratewell\/company\/[^/?#]+\/?(\?.*)?$/;
const PASSED_HEADERS = ['etag', 'x-rw-block', 'retry-after'];

export function passgateRouter(ctx: Ctx): Router {
  const r = Router();
  const credits = () => ctx.state.credits.passgate;

  r.use(chaos(ctx, 'passgate'));
  r.use((req, _res, next) => {
    if (bearer(req) !== ctx.config.passgate.key) throw new HttpError(401, { error: 'unauthorized' });
    next();
  });

  r.get('/v1/usage', (_req, res) => {
    const c = credits();
    res.json({ credits_remaining: c.remaining, credits_used: c.used, requests: c.requests });
  });

  r.get('/v1/fetch', async (req, res) => {
    const url = qs(req, 'url');
    if (
      url === undefined ||
      !(url.startsWith('/ratewell/') || url.startsWith('/agora/')) ||
      url.includes('..') ||
      url.includes('\\') ||
      /[\s#]/.test(url)
    ) {
      throw new HttpError(400, { error: 'unsupported_target' });
    }
    const renderParam = qs(req, 'render') ?? 'false';
    if (!['true', 'false', '1', '0'].includes(renderParam)) throw badRequest('render');
    const page = intParam(req, 'page', 1, 10_000, 1);
    const render = (renderParam === 'true' || renderParam === '1') && COMPANY_PAGE.test(url);
    const cost = render ? RENDER_COST : RAW_COST;

    const account = credits();
    const setCredits = (charged: number) =>
      res.set({ 'X-PassGate-Credits-Charged': String(charged), 'X-PassGate-Credits-Remaining': String(account.remaining) });
    if (account.remaining < cost) {
      setCredits(0);
      throw new HttpError(402, { error: 'insufficient_credits' });
    }
    account.requests += 1;

    const headers: Record<string, string> = {
      [INTERNAL_HEADER]: ctx.internalSecret,
      'user-agent': 'PassGate/1.0',
      'accept-language': 'en',
    };
    if (render) headers[RENDER_HEADER] = String(page);

    let target: Response;
    let body: Buffer;
    try {
      // Fetch through our own listener so the target's request log, chaos errors and layout all apply.
      target = await fetch(`http://127.0.0.1:${req.socket.localPort}${url}`, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(TARGET_TIMEOUT_MS),
      });
      body = Buffer.from(await target.arrayBuffer());
    } catch {
      setCredits(0);
      throw new HttpError(502, { error: 'target_unreachable' });
    }

    const charged = target.status >= 500 ? 0 : cost;
    account.remaining -= charged;
    account.used += charged;
    setCredits(charged);
    res.set('X-PassGate-Target-Status', String(target.status));
    for (const h of PASSED_HEADERS) {
      const v = target.headers.get(h);
      if (v !== null) res.set(h, v);
    }
    res.status(target.status).type(target.headers.get('content-type') ?? 'application/octet-stream').send(body);
  });

  r.use(() => {
    throw new HttpError(404, { error: 'not_found' });
  });
  return r;
}
