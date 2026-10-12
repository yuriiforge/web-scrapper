// Ratewell's client-side token, reimplemented. The site's app.js computes
// X-RW-Token = FNV-1a 32-bit hex of "<nonce>:<rw_sid>", where the nonce sits in an inline script
// on the company page and rw_sid is a cookie set by that page. Doing the same in Node gets the
// review JSON over plain HTTP, with no browser.

import { CollectorError } from '../errors';
import type { HttpResponse } from '../http';

export function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The per-response nonce from `window.__RW = {nonce: "..."}`. */
export function extractNonce(html: string): string | undefined {
  return /window\.__RW\s*=\s*\{\s*"?nonce"?\s*:\s*"([0-9a-f]+)"/.exec(html)?.[1];
}

/** The value of one cookie from Set-Cookie headers (fetch joins several with ", "). */
export function cookieFrom(setCookie: string | undefined, name: string): string | undefined {
  if (!setCookie) return undefined;
  const m = new RegExp(`(?:^|,\\s*)${name}=([^;,]+)`).exec(setCookie);
  return m?.[1];
}

/** A current desktop Chrome, as a normal visitor would send. */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
export const BROWSER_ACCEPT_LANGUAGE = 'en-GB,en;q=0.9';

/** 403 with X-RW-Block means a bot check stopped us; the reason (ua, webdriver, rate, forced) is in the header. */
export function blockedError(res: Pick<HttpResponse, 'url' | 'status' | 'headers'>): CollectorError | undefined {
  const reason = res.headers['x-rw-block'];
  if (res.status !== 403 || !reason) return undefined;
  return new CollectorError('blocked', `bot check blocked ${new URL(res.url).pathname} (reason: ${reason})`, 403);
}

/** The block reason from a blocked error's message, for logs and escalation decisions. */
export function blockReason(err: CollectorError): string {
  return /reason: (\w+)/.exec(err.message)?.[1] ?? 'unknown';
}
