import type { Db } from '@lp/db';
import { sql } from 'drizzle-orm';
import { sleep as defaultSleep, type Sleep } from './http';

export interface RateLimit {
  perMinute: number;
  /** Requests allowed back-to-back after an idle period. */
  burst: number;
}

/**
 * Token bucket stored in Postgres, so the limit holds across worker restarts and across
 * several workers. Taking a token is one atomic UPSERT: it refills by elapsed time and
 * takes a token only if a whole one is available.
 */
export class PgRateLimiter {
  constructor(
    private readonly db: Db,
    private readonly sleep: Sleep = defaultSleep,
  ) {}

  /** Resolves once a token for `key` has been taken. */
  async acquire(key: string, limit: RateLimit, signal?: AbortSignal): Promise<void> {
    for (;;) {
      const waitMs = await this.tryAcquire(key, limit);
      if (waitMs === 0) return;
      await this.sleep(waitMs, signal);
    }
  }

  /** 0 when a token was taken; otherwise how long to wait before one is available. */
  async tryAcquire(key: string, { perMinute, burst }: RateLimit): Promise<number> {
    const perSecond = perMinute / 60;
    const refilled = sql`least(${burst}::real, rate_buckets.tokens + extract(epoch from (now() - rate_buckets.updated_at))::real * ${perSecond}::real)`;
    const taken = await this.db.execute(sql`
      insert into rate_buckets (key, tokens, updated_at) values (${key}, ${burst - 1}, now())
      on conflict (key) do update set tokens = ${refilled} - 1, updated_at = now()
      where ${refilled} >= 1
      returning tokens`);
    if (taken.rows.length > 0) return 0;

    const state = await this.db.execute<{ tokens: number }>(sql`
      select ${refilled} as tokens from rate_buckets where key = ${key}`);
    const tokens = Number(state.rows[0]?.tokens ?? 0);
    return Math.max(10, Math.ceil(((1 - tokens) / perSecond) * 1000));
  }
}

/** Default bucket for a per-minute limit: a short burst, then an even pace. */
export function rateLimit(perMinute: number): RateLimit {
  return { perMinute, burst: Math.max(1, Math.min(5, Math.floor(perMinute / 10))) };
}
