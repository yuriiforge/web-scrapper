import type { Request, RequestHandler, Response } from 'express';
import type { Ctx } from '../context.js';

export interface RateInfo {
  allowed: boolean;
  limit: number;
  used: number;
  remaining: number;
  /** Ms until the oldest counted request leaves the window. */
  resetMs: number;
}

/** Sliding-log limiter: at most `limit` requests per key in any `windowMs`. Rejected requests are not counted. */
export function hit(buckets: Map<string, number[]>, key: string, limit: number, windowMs: number, now: number): RateInfo {
  const times = (buckets.get(key) ?? []).filter((t) => t > now - windowMs);
  const allowed = times.length < limit;
  if (allowed) times.push(now);
  buckets.set(key, times);
  const oldest = times[0] ?? now;
  return {
    allowed,
    limit,
    used: times.length,
    remaining: Math.max(0, limit - times.length),
    resetMs: Math.max(0, oldest + windowMs - now),
  };
}

export interface RateLimitOptions {
  /** Bucket key; null skips limiting for this request. */
  key: (req: Request, res: Response) => string | null;
  limit: () => number;
  windowMs: number;
  /** Sets the site's rate-limit headers on every limited-route response. */
  headers?: (res: Response, info: RateInfo) => void;
  /** Sends the site's over-limit response. */
  reject: (res: Response, info: RateInfo) => void;
}

/** Shared rate-limit middleware. Requests made through PassGate are exempt. */
export function rateLimit(ctx: Ctx, opts: RateLimitOptions): RequestHandler {
  return (req, res, next) => {
    if (res.locals.viaPassGate) return next();
    const key = opts.key(req, res);
    if (key === null) return next();
    const info = hit(ctx.state.buckets, key, opts.limit(), opts.windowMs, ctx.clock.now());
    opts.headers?.(res, info);
    if (!info.allowed) return opts.reject(res, info);
    next();
  };
}
