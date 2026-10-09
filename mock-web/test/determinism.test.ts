import request from 'supertest';
import type { Express } from 'express';
import { describe, expect, it } from 'vitest';
import { BROWSER, boot, ratewellData, ratewellSession, threaditToken } from './helpers.js';

/** First page of every listing, as raw response bodies. */
async function firstPages(app: Express): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const token = await threaditToken(app);
  for (const c of ['gb', 'de', 'fr', 'us', 'pl', 'ua', 'electric_cars', 'budget_airlines', 'meal_kits', 'fitness_trackers', 'online_banks']) {
    out[`threadit ${c}`] = (await request(app).get(`/threadit/c/${c}/new`).auth(token, { type: 'bearer' }).expect(200)).text;
  }
  out['threadit search'] = (await request(app).get('/threadit/c/us/search?q=price').auth(token, { type: 'bearer' }).expect(200)).text;
  out['threadit comments'] = (await request(app).get('/threadit/posts/t3_000100/comments').auth(token, { type: 'bearer' }).expect(200)).text;

  for (const path of ['/agora/', '/agora/latest', '/agora/latest.json', '/agora/t/at_000001', '/agora/t/at_000001.json']) {
    out[`agora ${path}`] = (await request(app).get(path).expect(200)).text;
  }
  for (const slug of ['electric-cars', 'budget-airlines', 'meal-kits', 'fitness-trackers', 'online-banks']) {
    out[`agora ${slug}`] = (await request(app).get(`/agora/c/${slug}`).expect(200)).text;
    out[`agora ${slug}.json`] = (await request(app).get(`/agora/c/${slug}.json`).expect(200)).text;
  }

  out['ratewell index'] = (await request(app).get('/ratewell/').set(BROWSER).expect(200)).text;
  for (const slug of ['voltra-motors', 'crate-ladle', 'tallycap']) {
    const s = await ratewellSession(app, slug);
    out[`ratewell ${slug}`] = (await ratewellData(app, slug, s).expect(200)).text;
  }

  out['chirp'] = (await request(app).get('/chirp/v2/search?query=a&max_results=100').auth('chirp-dev-key', { type: 'bearer' }).expect(200)).text;
  out['chirp gb'] = (await request(app).get('/chirp/v2/search?query=e&country=GB').auth('chirp-dev-key', { type: 'bearer' }).expect(200)).text;
  return out;
}

describe('determinism', () => {
  it('two boots with the same SEED and MOCK_NOW return byte-identical first pages', async () => {
    const a = await firstPages(boot().app);
    const b = await firstPages(boot().app);
    expect(Object.keys(a).length).toBeGreaterThan(25);
    for (const key of Object.keys(a)) expect(b[key], key).toBe(a[key]);
  });

  it('a different SEED gives different data', async () => {
    const { app } = boot({ SEED: '7' });
    const token = await threaditToken(app);
    const other = (await request(app).get('/threadit/c/gb/new').auth(token, { type: 'bearer' }).expect(200)).text;
    const base = await firstPages(boot().app);
    expect(other).not.toBe(base['threadit gb']);
  });
});
