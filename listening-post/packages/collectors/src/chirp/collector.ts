import type { ChirpConfig } from '@lp/shared';
import { z } from 'zod';
import { CollectorError, assertOk } from '../errors';
import type { HttpResponse } from '../http';
import type { Collector, CollectorDeps, FetchResult, ParsedItem, RawResponse, RunContext } from '../types';

/** Chirp never takes fewer than this per request, so it is also the smallest affordable step. */
const MIN_RESULTS = 10;
const DAY_MS = 86_400_000;

/** A span of time still to collect: posts created after `after` and before `before` (both exclusive). */
export interface ChirpWindow {
  after: string;
  /** Null for the open-ended window of new posts. */
  before: string | null;
}

export interface ChirpState {
  /** Windows left in this run, newest first; the first is in progress. */
  windows: ChirpWindow[];
  nextToken: string | null;
  /** Posts paid for so far in this run. */
  paid: number;
}

export interface ChirpCheckpoint {
  /** created_at of the newest post stored; newer posts form the next run's first window. */
  top: string | null;
  /** Older spans not collected yet, because a run stopped early (cap, budget, credits). */
  gaps: ChirpWindow[];
}

const searchResponse = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      author_id: z.string(),
      created_at: z.string(),
      lang: z.string(),
      geo: z.object({ country_code: z.string() }).nullable(),
      public_metrics: z.object({ like_count: z.number(), reply_count: z.number(), repost_count: z.number() }),
    }),
  ),
  meta: z.object({ result_count: z.number().int(), next_token: z.string().nullable() }),
  usage: z.object({ credits_charged: z.number().int(), credits_remaining: z.number().int() }),
});

/**
 * Metered-API collector for Chirp (stands in for the paid X/Twitter API). Strategy `api`: there is
 * no free path, and every post returned costs a credit, so the collector pays for each post once:
 *
 * - The checkpoint records what is still missing as time windows: everything newer than the newest
 *   stored post, plus any older gaps a run left when it stopped early. Chirp's `since`/`until` ask for
 *   exactly those windows, so a stored post is never bought twice, even after a run that ran out of
 *   credits (that checkpoint is saved too).
 * - It asks for no more posts than the source's budget covers, and stops before overspending.
 *   Chirp's smallest page is 10 posts, so it stops when fewer than 10 are affordable.
 * - It stops at `maxPostsPerRun`; the rest waits in the gaps for the next run.
 * - Every credit goes to the cost ledger as it is charged.
 */
export class ChirpCollector implements Collector<ChirpState, ChirpCheckpoint> {
  readonly site = 'chirp' as const;
  readonly strategy = 'api' as const;
  /** A run that stops for lack of credits or budget still records what it paid for. */
  readonly saveCheckpointOnPartial = true;

  private top: string | null = null;
  /** The newest post's time in the open window this run, which becomes the next `top`. */
  private newestThisRun: string | null = null;
  /** The oldest post's time in the window being collected, where a stopped run resumes. */
  private oldestInWindow: string | null = null;
  private remaining: ChirpWindow[] = [];

  constructor(
    private readonly config: ChirpConfig,
    private readonly deps: CollectorDeps,
    private readonly now: () => number = Date.now,
  ) {}

  /** Below Chirp's 30 requests a minute per key. */
  get ratePerMinute(): number {
    return this.config.ratePerMinute ?? 25;
  }

  initialState(checkpoint: ChirpCheckpoint | null): ChirpState {
    this.top = checkpoint?.top ?? null;
    const floor = new Date(this.now() - this.config.backfillDays * DAY_MS).toISOString();
    const windows: ChirpWindow[] = [{ after: this.top ?? floor, before: null }, ...(checkpoint?.gaps ?? [])];
    this.remaining = windows;
    return { windows, nextToken: null, paid: 0 };
  }

  /** New posts' window collected up to now, and whatever is left of the older windows. */
  checkpoint(): ChirpCheckpoint {
    const [current, ...rest] = this.remaining;
    const gaps: ChirpWindow[] = [];
    if (current && current.before !== null) {
      // Stopped inside an old gap: keep the part below the oldest post collected in it.
      gaps.push(this.oldestInWindow ? { after: current.after, before: this.oldestInWindow } : current);
    } else if (current && current.before === null && this.oldestInWindow && this.newestThisRun) {
      // Stopped inside the new-posts window: below what was collected there is still to do.
      gaps.push({ after: current.after, before: this.oldestInWindow });
    }
    gaps.push(...rest);
    return { top: this.newestThisRun ?? this.top, gaps: gaps.filter((g) => g.before === null || g.after < g.before) };
  }

  async fetchPage(ctx: RunContext, state: ChirpState): Promise<FetchResult<ChirpState>> {
    const chirp = this.deps.chirp;
    if (!chirp) throw new CollectorError('bad_request', 'Chirp is not configured for this worker');
    const window = state.windows[0]!;

    const want = Math.min(this.config.maxResults, this.config.maxPostsPerRun - state.paid);
    if (want < MIN_RESULTS) return { responses: [], next: null };
    const affordable = await this.affordablePosts(ctx, chirp.postUsd);
    const ask = affordable === null ? want : Math.min(want, affordable);
    if (ask < MIN_RESULTS) {
      throw new CollectorError('quota', `monthly budget for this source covers ${affordable} more posts; Chirp's minimum is ${MIN_RESULTS}`);
    }

    const url = new URL('/chirp/v2/search', this.deps.baseUrl);
    url.searchParams.set('query', this.config.query);
    url.searchParams.set('max_results', String(ask));
    if (this.config.country) url.searchParams.set('country', this.config.country);
    // `since` is inclusive and times are whole seconds: one second later excludes `after` itself.
    url.searchParams.set('since', new Date(Date.parse(window.after) + 1000).toISOString());
    if (window.before) url.searchParams.set('until', window.before);
    if (state.nextToken) url.searchParams.set('next_token', state.nextToken);

    const res = await ctx.http.request({ url: url.toString(), headers: { authorization: `Bearer ${chirp.key}`, accept: 'application/json' } });
    if (res.status === 402) throw new CollectorError('quota', 'Chirp credits are used up', 402);
    if (res.status === 401) throw new CollectorError('auth', 'Chirp rejected the API key', 401);
    assertOk(res);
    const page = this.decode(res);

    const charged = page.usage.credits_charged;
    if (charged > 0) await ctx.charge({ provider: 'chirp', units: charged, unit: 'post', usd: round(charged * chirp.postUsd) });
    for (const p of page.data) {
      if (window.before === null && (!this.newestThisRun || p.created_at > this.newestThisRun)) this.newestThisRun = p.created_at;
      if (!this.oldestInWindow || p.created_at < this.oldestInWindow) this.oldestInWindow = p.created_at;
    }
    await this.respectRateLimit(ctx, res);

    const paid = state.paid + charged;
    ctx.log.debug({ window, asked: ask, got: page.data.length, charged, remaining: page.usage.credits_remaining }, 'chirp page');

    if (page.meta.next_token !== null) {
      // More in this window. A run that reaches its cap here leaves the rest as a gap.
      return { responses: [res], next: paid < this.config.maxPostsPerRun ? { ...state, nextToken: page.meta.next_token, paid } : null };
    }
    // This window is done: move on to the next one, if any.
    const windows = state.windows.slice(1);
    this.remaining = windows;
    this.oldestInWindow = null;
    return { responses: [res], next: windows.length > 0 ? { windows, nextToken: null, paid } : null };
  }

  parse(raw: RawResponse): ParsedItem[] {
    return this.decode(raw).data.map((p) => ({
      externalId: p.id,
      author: p.author_id,
      text: p.text,
      country: p.geo?.country_code ?? null,
      publishedAt: new Date(p.created_at),
      meta: { lang: p.lang, likes: p.public_metrics.like_count, replies: p.public_metrics.reply_count, reposts: p.public_metrics.repost_count },
    }));
  }

  /** Posts the remaining monthly budget pays for, or null when the source has no budget. */
  private async affordablePosts(ctx: RunContext, postUsd: number): Promise<number | null> {
    const left = await ctx.budgetLeftUsd();
    if (left === null || postUsd <= 0) return null;
    return Math.max(0, Math.floor(left / postUsd + 1e-9));
  }

  /** When the window is used up, wait for its reset (epoch seconds) instead of spending a request on a 429. */
  private async respectRateLimit(ctx: RunContext, res: HttpResponse): Promise<void> {
    const remaining = Number(res.headers['x-rate-limit-remaining']);
    const reset = Number(res.headers['x-rate-limit-reset']);
    if (remaining === 0 && reset > 0) {
      const wait = reset * 1000 - ctx.now();
      if (wait > 0) {
        ctx.log.info({ waitMs: wait }, 'rate-limit window used up, waiting for reset');
        await ctx.sleep(wait + 250, ctx.signal);
      }
    }
  }

  private decode(raw: RawResponse): z.infer<typeof searchResponse> {
    let json: unknown;
    try {
      json = JSON.parse(raw.body);
    } catch {
      throw new CollectorError('parse', `invalid JSON from ${raw.url}`, raw.status, [raw]);
    }
    const r = searchResponse.safeParse(json);
    if (!r.success) {
      const issue = r.error.issues[0];
      throw new CollectorError('parse', `unexpected shape from ${raw.url} at ${issue?.path.join('.')}: ${issue?.message}`, raw.status, [raw]);
    }
    return r.data;
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
