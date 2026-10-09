import type { ErrorClass } from '@lp/shared';
import type { RawResponse } from './types';

/**
 * A failure with a class attached. The class, not the message, decides what happens next:
 * retry, wait, refresh credentials, escalate, stop as partial, or fail.
 */
export class CollectorError extends Error {
  constructor(
    readonly errorClass: ErrorClass,
    message: string,
    readonly status?: number,
    /** Responses fetched but not yet returned when this was thrown; the executor stores them for debugging. */
    readonly responses: RawResponse[] = [],
  ) {
    super(message);
    this.name = 'CollectorError';
  }
}

/** Statuses worth retrying with backoff. */
export function isTransientStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

/** Maps a final (non-retried) HTTP failure to its error class. */
export function classifyStatus(status: number, headers: Record<string, string> = {}): ErrorClass {
  if (isTransientStatus(status)) return 'transient';
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'auth';
  if (status === 402) return 'quota';
  if (status === 403) return headers['x-rw-block'] ? 'blocked' : 'auth';
  return 'bad_request';
}

/** Throws a classified error for any non-2xx response. */
export function assertOk(res: { status: number; url: string; headers: Record<string, string>; body: string }): void {
  if (res.status >= 200 && res.status < 300) return;
  const snippet = res.body.slice(0, 200).replace(/\s+/g, ' ');
  throw new CollectorError(classifyStatus(res.status, res.headers), `HTTP ${res.status} from ${res.url}: ${snippet}`, res.status);
}

/** The class of any thrown value; unknown errors are treated as transient. */
export function errorClassOf(err: unknown): ErrorClass {
  return err instanceof CollectorError ? err.errorClass : 'transient';
}
