import type { RequestHandler } from 'express';
import type { Ctx } from '../context.js';
import { SITES, type SiteName } from '../state.js';

export const INTERNAL_HEADER = 'x-mockweb-internal';

export function siteOf(path: string): SiteName | undefined {
  const first = path.split('/')[1];
  return (SITES as readonly string[]).includes(first ?? '') ? (first as SiteName) : undefined;
}

/** Records every site request, and marks requests PassGate makes on a caller's behalf. */
export function requestLog(ctx: Ctx): RequestHandler {
  return (req, res, next) => {
    res.locals.viaPassGate = req.get(INTERNAL_HEADER) === ctx.internalSecret;
    const site = siteOf(req.path);
    if (!site) return next();
    const ts = ctx.clock.now();
    const started = performance.now();
    res.on('close', () => {
      const entry = {
        ts,
        site,
        method: req.method,
        path: req.originalUrl,
        status: res.headersSent ? res.statusCode : 0,
        ms: Math.round(performance.now() - started),
        ip: req.ip ?? '',
        ua: req.get('user-agent') ?? '',
        via_passgate: res.locals.viaPassGate === true,
      };
      ctx.state.requests.push(entry);
      ctx.log.debug(entry, 'request');
    });
    next();
  };
}
