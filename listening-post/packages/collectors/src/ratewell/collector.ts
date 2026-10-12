import type { RatewellConfig, RatewellStep } from '@lp/shared';
import { CollectorError } from '../errors';
import type { Collector, CollectorDeps, FetchResult, ParsedItem, RawResponse, RunContext } from '../types';
import { BrowserFetcher, PassGateFetcher, PlainFetcher, type ReviewFetcher } from './fetchers';
import { parseAnyReviewPage, reviewToItem } from './parse';
import { blockReason } from './session';

const DAY_MS = 86_400_000;

export interface RatewellState {
  page: number;
}

export interface RatewellCheckpoint {
  /** created_at of the newest review stored; reviews come newest first, so a run stops there. */
  watermark: string | null;
  /** The lowest ladder step that worked last time; the next run starts there. */
  step: RatewellStep;
  /** When the source moved to that step. After a day on a costlier step, one step lower is tried again. */
  stepSince: string;
}

/**
 * Review-site collector for Ratewell (stands in for a review platform behind bot protection).
 *
 * The reviews load in the browser through a token the page computes, and the site blocks clients
 * that look automated. The collector climbs a ladder, cheapest first, and moves up only when blocked:
 *
 *   1. html       plain HTTP with the page's token reimplemented: free
 *   2. browser    Playwright, looking like a person's Chrome: compute cost
 *   3. unblocker  PassGate: 1 credit per page as raw JSON, 5 as a rendered page
 *
 * It remembers the lowest step that worked and starts there next time; after a day on a costlier
 * step it tries one step lower, so a lifted block stops costing money.
 */
export class RatewellCollector implements Collector<RatewellState, RatewellCheckpoint> {
  readonly site = 'ratewell' as const;

  private step: RatewellStep;
  private stepSince = new Date(0).toISOString();
  private since: string | null = null;
  private newest: string | null = null;
  private readonly fetchers = new Map<RatewellStep, ReviewFetcher>();

  constructor(
    private readonly config: RatewellConfig,
    private readonly deps: CollectorDeps,
  ) {
    this.step = config.strategies[0] as RatewellStep;
  }

  get strategy(): RatewellStep {
    return this.step;
  }

  /** Below the 30 data requests a minute that gets a session blocked for 5 minutes. */
  get ratePerMinute(): number {
    return this.config.ratePerMinute ?? 20;
  }

  initialState(checkpoint: RatewellCheckpoint | null): RatewellState {
    this.since = checkpoint?.watermark ?? null;
    this.newest = this.since;
    const allowed = this.config.strategies;
    if (checkpoint && allowed.includes(checkpoint.step)) {
      this.step = checkpoint.step;
      this.stepSince = checkpoint.stepSince;
      const i = allowed.indexOf(this.step);
      // A day on a costlier step: try the cheaper one again; a block sends it straight back up.
      if (i > 0 && Date.now() - Date.parse(checkpoint.stepSince) > DAY_MS) {
        this.step = allowed[i - 1] as RatewellStep;
        this.stepSince = new Date().toISOString();
      }
    }
    return { page: 1 };
  }

  checkpoint(): RatewellCheckpoint {
    return { watermark: this.newest, step: this.step, stepSince: this.stepSince };
  }

  async fetchPage(ctx: RunContext, state: RatewellState): Promise<FetchResult<RatewellState>> {
    let raw: RawResponse;
    for (;;) {
      try {
        raw = await this.fetcher(this.step).page(ctx, state.page);
        break;
      } catch (err) {
        if (!(err instanceof CollectorError) || err.errorClass !== 'blocked') throw err;
        const next = this.config.strategies[this.config.strategies.indexOf(this.step) + 1];
        if (!next) throw new CollectorError('blocked', `${err.message}; no higher step allowed for this source`, err.status);
        ctx.log.warn({ from: this.step, to: next, reason: blockReason(err), page: state.page }, 'blocked, escalating');
        await this.fetchers.get(this.step)?.close?.(ctx);
        this.step = next;
        this.stepSince = new Date(ctx.now()).toISOString();
      }
    }

    const page = parseAnyReviewPage(raw);
    if (!page) throw new CollectorError('parse', `no reviews in ${raw.url}`, raw.status, [raw]);
    ctx.listed(page.reviews.length);
    for (const r of page.reviews) if (!this.newest || r.createdAt > this.newest) this.newest = r.createdAt;
    const fresh = page.reviews.filter((r) => !this.since || r.createdAt > this.since);
    const reachedWatermark = fresh.length < page.reviews.length;
    const hitMax = this.config.maxPages !== undefined && state.page >= this.config.maxPages;
    ctx.log.debug({ page: state.page, step: this.step, reviews: page.reviews.length, fresh: fresh.length }, 'ratewell page');
    return { responses: [raw], next: page.hasMore && !reachedWatermark && !hitMax ? { page: state.page + 1 } : null };
  }

  parse(raw: RawResponse): ParsedItem[] {
    const page = parseAnyReviewPage(raw);
    if (!page) throw new CollectorError('parse', `no Ratewell parser for ${raw.url}`);
    return page.reviews.map(reviewToItem);
  }

  async close(ctx: RunContext): Promise<void> {
    for (const f of this.fetchers.values()) await f.close?.(ctx);
    this.fetchers.clear();
  }

  private fetcher(step: RatewellStep): ReviewFetcher {
    let f = this.fetchers.get(step);
    if (f) return f;
    const { baseUrl, passgate, browser } = this.deps;
    if (step === 'html') f = new PlainFetcher(baseUrl, this.config.company);
    else if (step === 'browser') f = new BrowserFetcher(baseUrl, this.config.company, browser ?? { headless: true, minuteUsd: 0 });
    else {
      if (!passgate) throw new CollectorError('bad_request', 'PassGate is not configured for this worker');
      f = new PassGateFetcher(this.config.company, passgate);
    }
    this.fetchers.set(step, f);
    return f;
  }
}

