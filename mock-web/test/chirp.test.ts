import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { admin, boot } from './helpers.js';

const KEY = 'chirp-dev-key';
type App = Parameters<typeof request>[0];
const search = (app: App, query: string) => request(app).get(`/chirp/v2/search?${query}`).auth(KEY, { type: 'bearer' });
const usage = async (app: App) => (await request(app).get('/chirp/v2/usage').auth(KEY, { type: 'bearer' }).expect(200)).body;

describe('chirp', () => {
  it('requires the API key', async () => {
    const { app } = boot();
    const res = await request(app).get('/chirp/v2/search?query=a');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });

  it('returns newest-first posts in the documented shape and charges per post', async () => {
    const { app } = boot();
    const res = await search(app, 'query=bank&max_results=100').expect(200);
    expect(res.body.data).toHaveLength(100);
    expect(res.body.meta.result_count).toBe(100);
    expect(res.body.meta.next_token).toEqual(expect.any(String));
    expect(res.body.usage).toEqual({ credits_charged: 100, credits_remaining: 9900 });
    const post = res.body.data[0];
    expect(Object.keys(post)).toEqual(['id', 'text', 'author_id', 'created_at', 'lang', 'geo', 'public_metrics']);
    expect(post.text.toLowerCase()).toContain('bank');
    const times = res.body.data.map((p: { created_at: string }) => p.created_at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(res.body.data.some((p: { geo: unknown }) => p.geo === null)).toBe(true);
    expect(await usage(app)).toEqual({ credits_remaining: 9900, credits_used: 100, requests: 1 });
  });

  it('pages with next_token without repeats', async () => {
    const { app } = boot();
    const first = await search(app, 'query=delivery&max_results=50').expect(200);
    await admin.publish(app, 'chirp', 20);
    const second = await search(app, `query=delivery&max_results=50&next_token=${first.body.meta.next_token}`).expect(200);
    const ids = [...first.body.data, ...second.body.data].map((p: { id: string }) => p.id);
    expect(new Set(ids).size).toBe(100);
  });

  it('returns a partial page for a balance of 30 and 402 at zero', async () => {
    const { app } = boot();
    await admin.credits(app, 'chirp', 30);
    const res = await search(app, 'query=e&max_results=100').expect(200);
    expect(res.body.data).toHaveLength(30);
    expect(res.body.usage).toEqual({ credits_charged: 30, credits_remaining: 0 });
    const broke = await search(app, 'query=e');
    expect(broke.status).toBe(402);
    expect(broke.body).toEqual({ error: 'quota_exhausted' });
  });

  it('charges 1 credit for a search with no results', async () => {
    const { app } = boot();
    const res = await search(app, 'query=zzzz-no-such-text').expect(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.usage.credits_charged).toBe(1);
  });

  it('filters by country and time range', async () => {
    const { app } = boot();
    const res = await search(app, 'query=a&country=pl&since=2026-09-01T00:00:00Z&until=2026-10-01T00:00:00Z&max_results=100').expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const p of res.body.data) {
      expect(p.geo).toEqual({ country_code: 'PL' });
      expect(p.created_at >= '2026-09-01T00:00:00Z' && p.created_at < '2026-10-01T00:00:00Z').toBe(true);
    }
  });

  it('rejects invalid parameters without charging', async () => {
    const { app } = boot();
    for (const [query, field] of [
      ['max_results=10', 'query'],
      ['query=a&max_results=5', 'max_results'],
      ['query=a&since=yesterday', 'since'],
      ['query=a&country=Poland', 'country'],
      ['query=a&next_token=bogus', 'next_token'],
    ] as const) {
      const res = await search(app, query);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'bad_request', field });
    }
    expect((await usage(app)).credits_used).toBe(0);
  });

  it('rate-limits per key with x-rate-limit headers, without charging', async () => {
    const { app } = boot({ CHIRP_RATE: '3' });
    for (let i = 0; i < 3; i++) {
      const ok = await search(app, 'query=a').expect(200);
      expect(ok.headers['x-rate-limit-limit']).toBe('3');
      expect(ok.headers['x-rate-limit-remaining']).toBe(String(2 - i));
      expect(Number(ok.headers['x-rate-limit-reset'])).toBeGreaterThan(Date.now() / 1000);
    }
    const limited = await search(app, 'query=a');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
    expect(limited.headers['x-rate-limit-remaining']).toBe('0');
  });
});
