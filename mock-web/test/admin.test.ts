import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { admin, boot, ratewellData, ratewellSession, threaditToken } from './helpers.js';

const BEARER = { type: 'bearer' } as const;

describe('admin', () => {
  it('reports state', async () => {
    const { app } = boot();
    const res = await request(app).get('/_admin/state').expect(200);
    expect(res.body.seed).toBe(42);
    expect(res.body.chaos.ratewell).toEqual({ errorRate: 0, timeoutRate: 0, latencyMs: 0, emptyResults: false, layoutVersion: 1, botCheckLevel: 1 });
    expect(res.body.chaos.agora).not.toHaveProperty('botCheckLevel');
    expect(res.body.credits.passgate.credits_remaining).toBe(2000);
    expect(res.body.credits.chirp.credits_remaining).toBe(10000);
    expect(res.body.items.chirp).toBe(15000);
  });

  it('returns a category and sentiment for every id served by any site', async () => {
    const { app, ctx } = boot();
    const ids = new Set<string>();

    const token = await threaditToken(app);
    const posts = (await request(app).get('/threadit/c/fr/new?limit=100').auth(token, BEARER).expect(200)).body.data.children;
    posts.forEach((c: { data: { id: string } }) => ids.add(c.data.id));
    const withComments = ctx.corpus.threadit.posts.find((p) => p.community === 'fr' && p.comments.length > 3)!;
    const comments = (await request(app).get(`/threadit/posts/${withComments.id}/comments`).auth(token, BEARER).expect(200)).body.data.children;
    comments.forEach((c: { data: { id: string } }) => ids.add(c.data.id));

    const topics = (await request(app).get('/agora/c/fitness-trackers.json').expect(200)).body.topics;
    topics.forEach((t: { id: string }) => ids.add(t.id));
    const agoraPosts = (await request(app).get(`/agora/t/${topics[0].id}.json`).expect(200)).body.posts;
    agoraPosts.forEach((p: { id: string }) => ids.add(p.id));

    const s = await ratewellSession(app, 'mintora');
    (await ratewellData(app, 'mintora', s).expect(200)).body.reviews.forEach((r: { id: string }) => ids.add(r.id));

    const chirp = (await request(app).get('/chirp/v2/search?query=a&max_results=100').auth('chirp-dev-key', BEARER).expect(200)).body.data;
    chirp.forEach((p: { id: string }) => ids.add(p.id));

    const published = (await admin.publish(app, 'chirp', 3)).body.ids as string[];
    published.forEach((id) => ids.add(id));

    const list = [...ids];
    expect(list.length).toBeGreaterThan(250);
    const truth = (await request(app).get(`/_admin/truth?ids=${list.join(',')}`).expect(200)).body;
    expect(truth).toHaveLength(list.length);
    for (const t of truth) {
      expect(['price', 'quality', 'customer service', 'reliability', 'usability', 'delivery']).toContain(t.category);
      expect(['negative', 'neutral', 'positive']).toContain(t.sentiment);
      expect(['GB', 'DE', 'FR', 'US', 'PL', 'UA']).toContain(t.country);
      expect(['threadit', 'agora', 'ratewell', 'chirp']).toContain(t.site);
    }
  });

  it('limits truth lookups to 500 ids', async () => {
    const { app } = boot();
    const ids = Array.from({ length: 501 }, (_, i) => `ch_${String(i + 1).padStart(7, '0')}`);
    const res = await request(app).get(`/_admin/truth?ids=${ids.join(',')}`);
    expect(res.status).toBe(400);
  });

  it('never exposes ground truth on the sites themselves', async () => {
    const { app } = boot();
    const s = await ratewellSession(app, 'mintora');
    const body = JSON.stringify((await ratewellData(app, 'mintora', s).expect(200)).body);
    expect(body).not.toMatch(/"sentiment"|"category"/);
  });

  it('publishes new items dated now, filtered by topic', async () => {
    const { app, ctx } = boot();
    const res = await admin.publish(app, 'ratewell', 2, 'online banks');
    expect(res.body.ids).toHaveLength(2);
    for (const id of res.body.ids) expect(ctx.corpus.truth.get(id)!.topic).toBe('online banks');
    const company = ctx.corpus.ratewell.companies.find((c) => c.reviews[0]!.id === res.body.ids[1])!;
    expect(company.reviews[0]!.created).toBe(ctx.corpusNow());
    expect((await request(app).post('/_admin/publish').send({ site: 'passgate', count: 1 })).status).toBe(400);
  });

  it('reset regenerates the corpus and clears credits, chaos and tokens', async () => {
    const { app } = boot();
    const token = await threaditToken(app);
    await admin.publish(app, 'chirp', 5);
    await admin.credits(app, 'chirp', 3);
    await admin.chaos(app, 'agora', { errorRate: 1 });
    const res = await request(app).post('/_admin/reset').expect(200);
    expect(res.body.items.chirp).toBe(15000);
    expect(res.body.credits.chirp.credits_remaining).toBe(10000);
    expect(res.body.chaos.agora.errorRate).toBe(0);
    await request(app).get('/threadit/c/gb/new').auth(token, BEARER).expect(401);
  });
});

describe('publishing comments', () => {
  it('adds comments to recent posts of one community, dated now', async () => {
    const { app, ctx } = boot();
    const res = await request(app).post('/_admin/publish').send({ site: 'threadit', kind: 'comments', count: 5, community: 'gb' }).expect(201);
    expect(res.body.ids).toHaveLength(5);
    for (const id of res.body.ids) {
      const post = ctx.corpus.threadit.posts.find((p) => p.comments.some((c) => c.id === id))!;
      expect(post.community).toBe('gb');
      expect(post.comments.at(-1)!.created).toBeGreaterThanOrEqual(post.created);
      expect(ctx.corpus.truth.get(id)).toMatchObject({ site: 'threadit' });
    }
  });
});
