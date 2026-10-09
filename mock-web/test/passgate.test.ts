import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { admin, boot, count } from './helpers.js';

const KEY = 'pg-dev-key';
const fetchVia = (app: Parameters<typeof request>[0], query: string) =>
  request(app).get(`/passgate/v1/fetch?${query}`).auth(KEY, { type: 'bearer' });

describe('passgate', () => {
  it('requires the API key', async () => {
    const { app } = boot();
    const res = await request(app).get('/passgate/v1/usage');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });

  it('rejects targets outside /ratewell/ and /agora/', async () => {
    const { app } = boot();
    for (const url of ['/threadit/c/gb/new', 'http://example.org/', '/ratewell/../chirp/v2/usage']) {
      const res = await fetchVia(app, `url=${encodeURIComponent(url)}`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'unsupported_target' });
    }
  });

  it('renders 20 reviews at bot-check level 3, charges 5 credits, then returns 402', async () => {
    const { app } = boot();
    await admin.chaos(app, 'ratewell', { botCheckLevel: 3 });
    await admin.credits(app, 'passgate', 12);

    const res = await fetchVia(app, `url=${encodeURIComponent('/ratewell/company/ledgerly')}&render=true`).expect(200);
    expect(count(res.text, '<article class="review"')).toBe(20);
    expect(res.headers['x-passgate-credits-charged']).toBe('5');
    expect(res.headers['x-passgate-credits-remaining']).toBe('7');

    const page2 = await fetchVia(app, `url=${encodeURIComponent('/ratewell/company/ledgerly')}&render=true&page=8`).expect(200);
    expect(count(page2.text, '<article class="review"')).toBe(10);
    expect(page2.text).not.toContain('<button id="load-more"');

    const broke = await fetchVia(app, `url=${encodeURIComponent('/ratewell/company/ledgerly')}&render=true`);
    expect(broke.status).toBe(402);
    expect(broke.body).toEqual({ error: 'insufficient_credits' });
    expect(broke.headers['x-passgate-credits-remaining']).toBe('2');

    const usage = await request(app).get('/passgate/v1/usage').auth(KEY, { type: 'bearer' }).expect(200);
    expect(usage.body).toEqual({ credits_remaining: 2, credits_used: 10, requests: 2 });
  });

  it('renders the same markup app.js produces', async () => {
    const { app } = boot();
    const res = await fetchVia(app, `url=${encodeURIComponent('/ratewell/company/ledgerly')}&render=true`).expect(200);
    expect(res.text).toMatch(
      /<article class="review" data-id="rv_\d+"><div class="review-rating" data-rating="[1-5]">[1-5]\/5<\/div><h3 class="review-title">[^<]+<\/h3><p class="review-body">[^<]*<\/p><footer><span class="review-author">[^<]+<\/span> <span class="review-country">[A-Z]{2}<\/span> <time datetime="[^"]+">\d{4}-\d\d-\d\d<\/time><\/footer><\/article>/,
    );
  });

  it('fetches raw pages for 1 credit, bypassing bot checks and rate limits', async () => {
    const { app, ctx } = boot({ AGORA_RATE: '1' });
    await admin.chaos(app, 'ratewell', { botCheckLevel: 3 });
    const shell = await fetchVia(app, `url=${encodeURIComponent('/ratewell/company/ledgerly')}`).expect(200);
    expect(shell.headers['x-passgate-credits-charged']).toBe('1');
    expect(count(shell.text, '<article class="review"')).toBe(0);

    const data = await fetchVia(app, `url=${encodeURIComponent('/ratewell/_data/company/ledgerly/reviews?page=2')}`).expect(200);
    expect(JSON.parse(data.text).reviews).toHaveLength(20);

    for (let i = 0; i < 5; i++) await fetchVia(app, `url=${encodeURIComponent('/agora/latest')}`).expect(200);
    expect(ctx.state.credits.passgate.remaining).toBe(2000 - 7);
  });

  it('passes the target status through and does not charge for 5xx', async () => {
    const { app } = boot();
    const missing = await fetchVia(app, `url=${encodeURIComponent('/agora/t/at_999999')}`);
    expect(missing.status).toBe(404);
    expect(missing.headers['x-passgate-credits-charged']).toBe('1');

    await admin.chaos(app, 'agora', { errorRate: 1 });
    const failed = await fetchVia(app, `url=${encodeURIComponent('/agora/latest')}`);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(failed.headers['x-passgate-credits-charged']).toBe('0');
  });

  it('is subject to its own chaos settings', async () => {
    const { app } = boot();
    await admin.chaos(app, 'passgate', { errorRate: 1 });
    const res = await request(app).get('/passgate/v1/usage').auth(KEY, { type: 'bearer' });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body).toEqual({ error: 'internal' });
  });
});
