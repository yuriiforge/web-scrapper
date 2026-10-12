import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { CollectorError } from '../src/errors';
import { HttpClient, retryAfterMs } from '../src/http';

const log = pino({ level: 'silent' });

/** A fetch that replays a script of responses (or thrown errors) and records the sleeps asked for. */
function scripted(script: (number | Error | { status: number; headers: Record<string, string> })[]) {
  const sleeps: number[] = [];
  let calls = 0;
  const fetch = (async () => {
    const step = script[Math.min(calls++, script.length - 1)]!;
    if (step instanceof Error) throw step;
    const { status, headers } = typeof step === 'number' ? { status: step, headers: {} } : step;
    return new Response(status === 204 ? null : `status ${status}`, { status, headers });
  }) as typeof globalThis.fetch;
  const client = new HttpClient({ log, fetch, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 });
  return { client, sleeps, calls: () => calls };
}

describe('HttpClient', () => {
  it('retries transient failures with exponential backoff, then succeeds', async () => {
    const { client, sleeps, calls } = scripted([503, new Error('ECONNRESET'), 502, 200]);
    const res = await client.request({ url: 'http://x/a' });
    expect(res.status).toBe(200);
    expect(calls()).toBe(4);
    // base 1000 ms, doubling; random 0.5 means no jitter offset.
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it('gives up after 5 retries with a transient error', async () => {
    const { client, calls } = scripted([500]);
    await expect(client.request({ url: 'http://x/a' })).rejects.toMatchObject({ errorClass: 'transient', status: 500 });
    expect(calls()).toBe(6);
  });

  it('waits out a 429 for Retry-After seconds without counting it as a failure', async () => {
    const { client, sleeps } = scripted([{ status: 429, headers: { 'retry-after': '7' } }, 200]);
    expect((await client.request({ url: 'http://x/a' })).status).toBe(200);
    expect(sleeps).toEqual([7000]);
  });

  it('returns other 4xx responses to the caller without retrying', async () => {
    const { client, calls } = scripted([404]);
    expect((await client.request({ url: 'http://x/a' })).status).toBe(404);
    expect(calls()).toBe(1);
  });

  it('stops immediately when the run is aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const client = new HttpClient({ log, signal: controller.signal, fetch: (async () => new Response('')) as typeof fetch });
    await expect(client.request({ url: 'http://x/a' })).rejects.toThrow('cancelled');
  });

  it('caps backoff and adds +-30% jitter', () => {
    const low = new HttpClient({ log, random: () => 0 });
    const high = new HttpClient({ log, random: () => 1 });
    expect(low.backoffMs(1)).toBe(700);
    expect(high.backoffMs(1)).toBe(1300);
    expect(high.backoffMs(20)).toBe(39_000);
  });
});

describe('retryAfterMs', () => {
  it('reads seconds and HTTP dates', () => {
    expect(retryAfterMs({ 'retry-after': '3' })).toBe(3000);
    expect(retryAfterMs({ 'retry-after': 'Wed, 07 Oct 2026 12:00:10 GMT' }, Date.parse('2026-10-07T12:00:00Z'))).toBe(10_000);
    expect(retryAfterMs({})).toBeUndefined();
  });
});

it('CollectorError keeps its class', () => {
  expect(new CollectorError('quota', 'x').errorClass).toBe('quota');
});

describe('late headers', () => {
  it('are computed after the rate-limit wait, once per attempt', async () => {
    const order: string[] = [];
    let attempt = 0;
    const seen: (string | null)[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get('authorization'));
      return new Response('', { status: attempt++ === 0 ? 503 : 200 });
    }) as typeof globalThis.fetch;
    const client = new HttpClient({
      log,
      fetch,
      sleep: async () => undefined,
      acquire: async () => void order.push('acquire'),
    });
    let n = 0;
    await client.request({ url: 'http://x/a', lateHeaders: async () => (order.push('headers'), { authorization: `Bearer t${++n}` }) });
    expect(order).toEqual(['acquire', 'headers', 'acquire', 'headers']);
    expect(seen).toEqual(['Bearer t1', 'Bearer t2']);
  });
});
