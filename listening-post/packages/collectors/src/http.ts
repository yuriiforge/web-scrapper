import type { Logger } from 'pino';
import { CollectorError, isTransientStatus } from './errors';

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  url: string;
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  body: string;
  fetchedAt: Date;
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export interface HttpClientOptions {
  log: Logger;
  /** Waits for a rate-limit token before every attempt, retries included. */
  acquire?: (url: string) => Promise<void>;
  /** Called once per attempt actually sent, for request accounting. */
  onAttempt?: (url: string) => void;
  signal?: AbortSignal;
  /** Retries for transient failures (5xx, network errors, timeouts). */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 429s are waited out, not counted as failures, up to this many times per request. */
  maxRateLimitWaits?: number;
  defaultTimeoutMs?: number;
  userAgent?: string;
  fetch?: typeof fetch;
  sleep?: Sleep;
  random?: () => number;
}

/**
 * fetch with a timeout per attempt, exponential backoff with jitter for transient failures,
 * and Retry-After handling for 429. Any other status is returned to the caller to judge.
 */
export class HttpClient {
  private readonly o: Required<Omit<HttpClientOptions, 'acquire' | 'signal' | 'onAttempt'>> & Pick<HttpClientOptions, 'acquire' | 'signal' | 'onAttempt'>;

  constructor(opts: HttpClientOptions) {
    this.o = {
      maxRetries: 5,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      maxRateLimitWaits: 10,
      defaultTimeoutMs: 15_000,
      userAgent: 'ListeningPost/0.1 (+https://github.com/; learning project)',
      fetch: globalThis.fetch.bind(globalThis),
      sleep,
      random: Math.random,
      ...opts,
    };
  }

  /** Delay before retry number `attempt` (1-based): base * 2^(attempt-1), +-30% jitter, capped. */
  backoffMs(attempt: number): number {
    const raw = Math.min(this.o.maxDelayMs, this.o.baseDelayMs * 2 ** (attempt - 1));
    return Math.round(raw * (0.7 + 0.6 * this.o.random()));
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    let failures = 0;
    let rateWaits = 0;
    for (;;) {
      this.o.signal?.throwIfAborted();
      await this.o.acquire?.(req.url);
      let res: HttpResponse;
      try {
        res = await this.once(req);
      } catch (err) {
        if (this.o.signal?.aborted) throw this.o.signal.reason;
        failures += 1;
        const reason = err instanceof Error ? err.message : String(err);
        if (failures > this.o.maxRetries) throw new CollectorError('transient', `${req.url} failed ${failures} times: ${reason}`);
        const delay = this.backoffMs(failures);
        this.o.log.warn({ url: req.url, attempt: failures, delay, reason }, 'request failed, retrying');
        await this.o.sleep(delay, this.o.signal);
        continue;
      }

      if (res.status === 429) {
        rateWaits += 1;
        if (rateWaits > this.o.maxRateLimitWaits) {
          throw new CollectorError('rate_limited', `${req.url} still rate limited after ${rateWaits - 1} waits`, 429);
        }
        const delay = retryAfterMs(res.headers) ?? this.backoffMs(rateWaits);
        this.o.log.info({ url: req.url, delay }, 'rate limited, waiting');
        await this.o.sleep(delay, this.o.signal);
        continue;
      }

      if (isTransientStatus(res.status)) {
        failures += 1;
        if (failures > this.o.maxRetries) {
          throw new CollectorError('transient', `${req.url} returned ${res.status} ${failures} times`, res.status);
        }
        const delay = this.backoffMs(failures);
        this.o.log.warn({ url: req.url, status: res.status, attempt: failures, delay }, 'server error, retrying');
        await this.o.sleep(delay, this.o.signal);
        continue;
      }
      return res;
    }
  }

  private async once(req: HttpRequest): Promise<HttpResponse> {
    const timeout = AbortSignal.timeout(req.timeoutMs ?? this.o.defaultTimeoutMs);
    const signal = this.o.signal ? AbortSignal.any([timeout, this.o.signal]) : timeout;
    this.o.onAttempt?.(req.url);
    const res = await this.o.fetch(req.url, {
      method: req.method ?? 'GET',
      headers: { 'user-agent': this.o.userAgent, ...req.headers },
      body: req.body,
      redirect: 'follow',
      signal,
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { url: req.url, status: res.status, headers, body: await res.text(), fetchedAt: new Date() };
  }
}

/** Retry-After in seconds or as an HTTP date; undefined when absent or unreadable. */
export function retryAfterMs(headers: Record<string, string>, now = Date.now()): number | undefined {
  const value = headers['retry-after'];
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
