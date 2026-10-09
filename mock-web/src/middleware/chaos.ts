import type { RequestHandler } from 'express';
import type { Ctx } from '../context.js';
import type { SiteName } from '../state.js';

const TIMEOUT_HOLD_MS = 30_000;

/** Applies latency, injected errors and timeouts for one site. Layout and empty results are read by the handlers. */
export function chaos(ctx: Ctx, site: SiteName): RequestHandler {
  return (req, res, next) => {
    const settings = ctx.state.chaos[site];
    const rng = ctx.state.chaosRng;

    const decide = () => {
      if (settings.timeoutRate > 0 && rng.next() < settings.timeoutRate) {
        const timer = setTimeout(() => req.socket.destroy(), TIMEOUT_HOLD_MS);
        res.on('close', () => clearTimeout(timer));
        return;
      }
      if (settings.errorRate > 0 && rng.next() < settings.errorRate) {
        res.status(rng.pick([500, 502, 503])).json({ error: 'internal' });
        return;
      }
      next();
    };

    if (settings.latencyMs > 0) setTimeout(decide, settings.latencyMs);
    else decide();
  };
}
