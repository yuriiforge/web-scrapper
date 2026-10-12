import type { Site, Strategy } from '@lp/shared';
import type { Logger } from 'pino';
import type { HttpClient, HttpResponse, Sleep } from './http';

/** A response as stored in raw_responses and handed to parse(). */
export type RawResponse = Pick<HttpResponse, 'url' | 'status' | 'headers' | 'body' | 'fetchedAt'>;

/** One record ready for the items table, before normalisation and hashing. */
export interface ParsedItem {
  externalId: string;
  author: string | null;
  text: string;
  /** ISO 3166-1 alpha-2, or null when the source does not say. */
  country: string | null;
  publishedAt: Date | null;
  /** Site-specific fields worth keeping, e.g. { rating: 4 }. */
  meta?: Record<string, unknown>;
}

/** One billable event, recorded in the cost ledger against the run, source and client. */
export interface Charge {
  /** e.g. "passgate", "browser". */
  provider: string;
  units: number;
  /** e.g. "credit", "browser-minute". */
  unit: string;
  usd: number;
}

export interface RunContext {
  http: HttpClient;
  log: Logger;
  signal: AbortSignal;
  sleep: Sleep;
  now: () => number;
  /** ETag from the last successful run for a URL, for If-None-Match. New ETags are saved by the executor. */
  etag: (url: string) => Promise<string | undefined>;
  /** Records a cost immediately, so spend is kept even if the run fails later. */
  charge: (charge: Charge) => Promise<void>;
  /** What is left of the source's monthly budget in USD, or null when it has none. Check before paid calls. */
  budgetLeftUsd: () => Promise<number | null>;
}

/** What one fetchPage call produced. */
export interface FetchResult<State> {
  responses: RawResponse[];
  /** State for the next call, or null when the run is complete. */
  next: State | null;
}

/**
 * One source's collector, created per run. Adding a site means implementing this; the run
 * executor handles queueing, retries, raw storage, upserts, costs, checkpoints and run status.
 */
export interface Collector<State = unknown, Checkpoint = unknown> {
  readonly site: Site;
  /** The strategy in use; collectors with an escalation ladder change it during a run. */
  readonly strategy: Strategy;
  /** Outbound requests per minute to this site; the worker default applies when unset. */
  readonly ratePerMinute?: number;
  /** Requests allowed back-to-back; 1 means strictly evenly spaced (e.g. for a robots.txt Crawl-delay). */
  readonly burst?: number;
  /** Where a run starts, given the checkpoint from the last successful run (null on the first run). */
  initialState(checkpoint: Checkpoint | null): State;
  /** Fetches one unit of work (a page, plus anything that hangs off it). */
  fetchPage(ctx: RunContext, state: State): Promise<FetchResult<State>>;
  /** Pure: turns one stored response into items. Throws CollectorError('parse') on unexpected shape. */
  parse(raw: RawResponse): ParsedItem[];
  /** Checkpoint to save after a successful run. */
  checkpoint(): Checkpoint | null;
  /** Releases what the run held open (a browser, for example). Called once, success or not. */
  close?(ctx: RunContext): Promise<void>;
}

export interface CollectorDeps {
  baseUrl: string;
  threadit: { clientId: string; clientSecret: string };
  passgate?: { baseUrl: string; key: string; creditUsd: number };
  /** `hideWebdriver: false` exists only to prove in tests that hiding it is what gets past the check. */
  browser?: { minuteUsd: number; headless: boolean; hideWebdriver?: boolean };
}
