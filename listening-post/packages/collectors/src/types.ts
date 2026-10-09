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
}

export interface RunContext {
  http: HttpClient;
  log: Logger;
  signal: AbortSignal;
  sleep: Sleep;
  now: () => number;
}

/** What one fetchPage call produced. */
export interface FetchResult<State> {
  responses: RawResponse[];
  /** State for the next call, or null when the run is complete. */
  next: State | null;
}

/**
 * One source's collector, created per run. Adding a site means implementing this; the run
 * executor handles queueing, retries, raw storage, upserts, checkpoints and run status.
 */
export interface Collector<State = unknown, Checkpoint = unknown> {
  readonly site: Site;
  readonly strategy: Strategy;
  /** Outbound requests per minute to this site; the worker default applies when unset. */
  readonly ratePerMinute?: number;
  /** Where a run starts, given the checkpoint from the last successful run (null on the first run). */
  initialState(checkpoint: Checkpoint | null): State;
  /** Fetches one unit of work (a page, plus anything that hangs off it). */
  fetchPage(ctx: RunContext, state: State): Promise<FetchResult<State>>;
  /** Pure: turns one stored response into items. Throws CollectorError('parse') on unexpected shape. */
  parse(raw: RawResponse): ParsedItem[];
  /** Checkpoint to save after a successful run. */
  checkpoint(): Checkpoint | null;
}

export interface CollectorDeps {
  baseUrl: string;
  threadit: { clientId: string; clientSecret: string };
}
