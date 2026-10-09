import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { admin, boot, threaditToken } from './helpers.js';

describe('threadit', () => {
  it('issues tokens only for valid client credentials', async () => {
    const { app } = boot();
    const bad = await request(app)
      .post('/threadit/api/v1/access_token')
      .auth('dev-id', 'wrong')
      .type('form')
      .send({ grant_type: 'client_credentials' });
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ error: 'invalid_client' });

    const ok = await request(app)
      .post('/threadit/api/v1/access_token')
      .auth('dev-id', 'dev-secret')
      .type('form')
      .send({ grant_type: 'client_credentials' })
      .expect(200);
    expect(ok.body).toMatchObject({ token_type: 'bearer', expires_in: 300 });
    expect(typeof ok.body.access_token).toBe('string');
  });

  it('rejects data calls without a valid token', async () => {
    const { app } = boot();
    const none = await request(app).get('/threadit/c/gb/new');
    expect(none.status).toBe(401);
    expect(none.body).toEqual({ error: 'invalid_token' });
    const unknown = await request(app).get('/threadit/c/gb/new').set('Authorization', 'Bearer nope');
    expect(unknown.status).toBe(401);
  });

  it('expires tokens after THREADIT_TOKEN_TTL', async () => {
    const { app, ctx } = boot();
    const token = await threaditToken(app);
    await request(app).get('/threadit/c/gb/new').auth(token, { type: 'bearer' }).expect(200);
    ctx.clock.offsetMs += 299_000;
    await request(app).get('/threadit/c/gb/new').auth(token, { type: 'bearer' }).expect(200);
    ctx.clock.offsetMs += 2_000;
    const res = await request(app).get('/threadit/c/gb/new').auth(token, { type: 'bearer' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_token' });
  });

  it('returns 429 with Retry-After on request 61 inside a minute', async () => {
    const { app } = boot();
    const token = await threaditToken(app);
    let last;
    for (let i = 1; i <= 60; i++) {
      last = await request(app).get('/threadit/c/gb/new?limit=1').auth(token, { type: 'bearer' }).expect(200);
    }
    expect(last!.headers['x-ratelimit-used']).toBe('60');
    expect(last!.headers['x-ratelimit-remaining']).toBe('0');
    expect(Number(last!.headers['x-ratelimit-reset'])).toBeGreaterThan(0);

    const res = await request(app).get('/threadit/c/gb/new?limit=1').auth(token, { type: 'bearer' });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
    expect(res.body.retry_after).toBeGreaterThan(0);
    expect(res.headers['retry-after']).toBe(String(res.body.retry_after));
  });

  it('lists newest first in the documented shape', async () => {
    const { app } = boot();
    const token = await threaditToken(app);
    const res = await request(app).get('/threadit/c/gb/new').auth(token, { type: 'bearer' }).expect(200);
    const children = res.body.data.children;
    expect(children).toHaveLength(25);
    expect(children[0].kind).toBe('t3');
    expect(Object.keys(children[0].data)).toEqual([
      'id', 'community', 'title', 'selftext', 'author', 'created_utc', 'score', 'num_comments', 'permalink',
    ]);
    const times = children.map((c: { data: { created_utc: number } }) => c.data.created_utc);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(res.body.data.after).toBe(children[24].data.id);
  });

  it('pages through a community exactly once, even with posts published mid-way', async () => {
    const { app, ctx } = boot();
    const token = await threaditToken(app);
    const expected = new Set(ctx.corpus.threadit.posts.filter((p) => p.community === 'gb').map((p) => p.id));
    const seen: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const url: string = `/threadit/c/gb/new?limit=50${after ? `&after=${after}` : ''}`;
      const res = await request(app).get(url).auth(token, { type: 'bearer' }).expect(200);
      seen.push(...res.body.data.children.map((c: { data: { id: string } }) => c.data.id));
      after = res.body.data.after;
      if (++pages === 2) await admin.publish(app, 'threadit', 40);
    } while (after);

    expect(new Set(seen).size).toBe(seen.length);
    for (const id of expected) expect(seen).toContain(id);
  });

  it('filters search by case-insensitive substring', async () => {
    const { app } = boot();
    const token = await threaditToken(app);
    const res = await request(app).get('/threadit/c/electric_cars/search?q=VOLTRA&limit=100').auth(token, { type: 'bearer' }).expect(200);
    expect(res.body.data.children.length).toBeGreaterThan(0);
    for (const c of res.body.data.children) {
      expect(`${c.data.title} ${c.data.selftext}`.toLowerCase()).toContain('voltra');
    }
  });

  it('pages comments oldest first', async () => {
    const { app, ctx } = boot();
    const token = await threaditToken(app);
    const post = ctx.corpus.threadit.posts.find((p) => p.comments.length >= 10)!;
    const first = await request(app).get(`/threadit/posts/${post.id}/comments?limit=5`).auth(token, { type: 'bearer' }).expect(200);
    expect(first.body.data.children[0]).toMatchObject({ kind: 't1', data: { post_id: post.id } });
    const second = await request(app)
      .get(`/threadit/posts/${post.id}/comments?limit=100&after=${first.body.data.after}`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    const ids = [...first.body.data.children, ...second.body.data.children].map((c: { data: { id: string } }) => c.data.id);
    expect(ids).toEqual(post.comments.map((c) => c.id));
    expect(second.body.data.after).toBeNull();
  });

  it('returns 404 and 400 in the documented shapes', async () => {
    const { app } = boot();
    const token = await threaditToken(app);
    const auth = { type: 'bearer' } as const;
    expect((await request(app).get('/threadit/c/nowhere/new').auth(token, auth)).body).toEqual({ error: 'not_found' });
    expect((await request(app).get('/threadit/posts/t3_999999/comments').auth(token, auth)).status).toBe(404);
    const badLimit = await request(app).get('/threadit/c/gb/new?limit=101').auth(token, auth);
    expect(badLimit.status).toBe(400);
    expect(badLimit.body).toEqual({ error: 'bad_request', field: 'limit' });
    const badAfter = await request(app).get('/threadit/c/gb/new?after=t3_nope').auth(token, auth);
    expect(badAfter.body).toEqual({ error: 'bad_request', field: 'after' });
  });
});
