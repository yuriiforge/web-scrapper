import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { BROWSER, admin, boot, ratewellData, ratewellSession, threaditToken } from './helpers.js';

const CHIRP = { type: 'bearer' } as const;

describe('chaos', () => {
  it('errorRate 1 fails every request to that site and leaves other sites alone', async () => {
    const { app } = boot();
    await admin.chaos(app, 'agora', { errorRate: 1 });
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get('/agora/latest');
      expect([500, 502, 503]).toContain(res.status);
      expect(res.body).toEqual({ error: 'internal' });
    }
    await request(app).get('/ratewell/').set(BROWSER).expect(200);
    await request(app).get('/chirp/v2/usage').auth('chirp-dev-key', CHIRP).expect(200);
    await request(app).get('/_admin/state').expect(200);
    await admin.chaos(app, 'agora', { errorRate: 0 });
    await request(app).get('/agora/latest').expect(200);
  });

  it('applies to every site with "all", but never to /_admin', async () => {
    const { app } = boot();
    await admin.chaos(app, 'all', { errorRate: 1 });
    for (const url of ['/agora/', '/ratewell/', '/chirp/v2/usage', '/passgate/v1/usage', '/threadit/c/gb/new']) {
      expect((await request(app).get(url)).status).toBeGreaterThanOrEqual(500);
    }
    await request(app).get('/_admin/state').expect(200);
  });

  it('adds latency', async () => {
    const { app } = boot();
    await admin.chaos(app, 'agora', { latencyMs: 300 });
    const start = Date.now();
    await request(app).get('/agora/robots.txt').expect(200);
    expect(Date.now() - start).toBeGreaterThanOrEqual(290);
  });

  it('emptyResults returns 200 with zero items and no next cursor or page', async () => {
    const { app } = boot();
    await admin.chaos(app, 'all', { emptyResults: true });

    const token = await threaditToken(app);
    const t = await request(app).get('/threadit/c/gb/new').auth(token, CHIRP).expect(200);
    expect(t.body).toEqual({ data: { children: [], after: null } });

    const a = await request(app).get('/agora/latest.json').expect(200);
    expect(a.body.topics).toEqual([]);
    const aHtml = await request(app).get('/agora/c/meal-kits').expect(200);
    expect(aHtml.text).not.toContain('topic-row');
    expect(aHtml.text).not.toContain('next-page');

    const s = await ratewellSession(app, 'fairwing');
    const r = await ratewellData(app, 'fairwing', s).expect(200);
    expect(r.body).toMatchObject({ reviews: [], has_more: false });

    const c = await request(app).get('/chirp/v2/search?query=a').auth('chirp-dev-key', CHIRP).expect(200);
    expect(c.body.data).toEqual([]);
    expect(c.body.meta.next_token).toBeNull();
  });

  it('validates settings', async () => {
    const { app } = boot();
    expect((await request(app).put('/_admin/chaos/agora').send({ errorRate: 2 })).status).toBe(400);
    expect((await request(app).put('/_admin/chaos/agora').send({ botCheckLevel: 2 })).body).toMatchObject({ field: 'botCheckLevel' });
    expect((await request(app).put('/_admin/chaos/agora').send({ bogus: 1 })).status).toBe(400);
    expect((await request(app).put('/_admin/chaos/nowhere').send({})).status).toBe(404);
  });
});

describe('layout version 2', () => {
  it('applies each breaking change and version 1 restores it', async () => {
    const { app } = boot();
    const token = await threaditToken(app);
    const session = await ratewellSession(app, 'pulseroo');

    const snapshot = async () => {
      const t = (await request(app).get('/threadit/c/de/new?limit=1').auth(token, CHIRP).expect(200)).body.data.children[0].data;
      const aHtml = (await request(app).get('/agora/t/at_000005').expect(200)).text;
      const aJson = (await request(app).get('/agora/t/at_000005.json').expect(200)).body.posts[0];
      const rJson = (await ratewellData(app, 'pulseroo', session).expect(200)).body;
      const rHtml = (
        await request(app)
          .get(`/passgate/v1/fetch?url=${encodeURIComponent('/ratewell/company/pulseroo')}&render=true`)
          .auth('pg-dev-key', CHIRP)
          .expect(200)
      ).text;
      const chirp = (await request(app).get('/chirp/v2/search?query=a&country=GB').auth('chirp-dev-key', CHIRP).expect(200)).body.data[0];
      return { t, aHtml, aJson, rJson, rHtml, chirp };
    };

    const v1 = await snapshot();
    expect(v1.t).toHaveProperty('selftext');
    expect(v1.aHtml).toContain('class="post-body"');
    expect(v1.aJson).toHaveProperty('cooked');
    expect(typeof v1.rJson.reviews[0].rating).toBe('number');
    expect(v1.rHtml).toContain('class="review-body"');
    expect(v1.chirp.geo).toHaveProperty('country_code');
    expect(v1.chirp).toHaveProperty('public_metrics');

    await admin.chaos(app, 'all', { layoutVersion: 2 });
    const v2 = await snapshot();
    expect(v2.t).not.toHaveProperty('selftext');
    expect(v2.t.body_text).toBe(v1.t.selftext);
    expect(v2.aHtml).not.toContain('class="post-body"');
    expect(v2.aHtml).toContain('class="post-content"');
    expect(v2.aJson).not.toHaveProperty('cooked');
    expect(v2.aJson.html).toBe(v1.aJson.cooked);
    expect(v2.rJson).not.toHaveProperty('reviews');
    expect(v2.rJson.items[0].rating).toBe(`${v1.rJson.reviews[0].rating}/5`);
    expect(v2.rHtml).not.toContain('class="review-body"');
    expect(v2.rHtml).toContain('class="rv-text"');
    expect(v2.chirp).not.toHaveProperty('public_metrics');
    expect(v2.chirp.metrics.public_metrics).toEqual(v1.chirp.public_metrics);
    expect(v2.chirp.geo).toEqual({ country: 'GB' });

    await admin.chaos(app, 'all', { layoutVersion: 1 });
    const back = await snapshot();
    expect(back.t).toEqual(v1.t);
    expect(back.aHtml).toBe(v1.aHtml);
    expect(back.aJson).toEqual(v1.aJson);
    expect(back.rJson).toEqual(v1.rJson);
    expect(back.chirp).toEqual(v1.chirp);
  });
});
