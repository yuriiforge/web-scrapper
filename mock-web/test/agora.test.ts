import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { admin, boot, count } from './helpers.js';

describe('agora', () => {
  it('lists categories and never mentions the JSON endpoints in HTML', async () => {
    const { app } = boot();
    const home = await request(app).get('/agora/').expect(200);
    expect(count(home.text, 'class="category-link"')).toBe(5);
    const cat = await request(app).get('/agora/c/meal-kits').expect(200);
    const topic = await request(app).get('/agora/t/at_000001').expect(200);
    for (const html of [home.text, cat.text, topic.text]) expect(html).not.toMatch(/\.json/);
  });

  it('serves 30 topics per page with the v1 row markup and a next link', async () => {
    const { app } = boot();
    const res = await request(app).get('/agora/c/electric-cars').expect(200);
    expect(count(res.text, 'class="topic-row"')).toBe(30);
    expect(res.text).toMatch(/<tr class="topic-row" data-topic-id="at_\d{6}"><td><a class="topic-title"/);
    expect(res.text).toContain('class="topic-replies"');
    expect(res.text).toMatch(/<time datetime="\d{4}-\d\d-\d\dT[\d:]+Z">/);
    expect(res.text).toContain('<a class="next-page" rel="next" href="/agora/c/electric-cars?page=2">');

    const json = await request(app).get('/agora/c/electric-cars.json').expect(200);
    expect(json.body).toMatchObject({ category: 'electric-cars', page: 1, per_page: 30 });
    const last = Math.ceil(json.body.total_topics / 30);
    const lastPage = await request(app).get(`/agora/c/electric-cars?page=${last}`).expect(200);
    expect(lastPage.text).not.toContain('next-page');
    await request(app).get(`/agora/c/electric-cars?page=${last + 1}`).expect(404);
    await request(app).get(`/agora/c/electric-cars.json?page=${last + 1}`).expect(404);
  });

  it('has the same posts in the HTML and JSON of a topic', async () => {
    const { app, ctx } = boot();
    const topic = ctx.corpus.agora.topics.find((t) => t.posts.length > 25)!;
    for (const page of [1, 2]) {
      const html = await request(app).get(`/agora/t/${topic.id}?page=${page}`).expect(200);
      const json = await request(app).get(`/agora/t/${topic.id}.json?page=${page}`).expect(200);
      const htmlPosts = [...html.text.matchAll(/<article class="post" data-post-id="([^"]+)" data-post-number="(\d+)">[\s\S]*?<div class="post-body">([\s\S]*?)<\/div>\n<\/article>/g)].map(
        (m) => ({ id: m[1], post_number: Number(m[2]), cooked: m[3] }),
      );
      const jsonPosts = json.body.posts.map((p: { id: string; post_number: number; cooked: string }) => ({
        id: p.id,
        post_number: p.post_number,
        cooked: p.cooked,
      }));
      expect(htmlPosts.length).toBeGreaterThan(0);
      expect(htmlPosts).toEqual(jsonPosts);
    }
  });

  it('returns 304 for a matching If-None-Match', async () => {
    const { app } = boot();
    for (const url of ['/agora/t/at_000010', '/agora/latest.json', '/agora/c/online-banks']) {
      const first = await request(app).get(url).expect(200);
      expect(first.headers.etag).toMatch(/^"[^"]+"$/);
      const again = await request(app).get(url).set('If-None-Match', first.headers.etag).expect(304);
      expect(again.text ?? '').toBe('');
    }
  });

  it('changes a topic ETag when a post is published to it', async () => {
    const { app, ctx } = boot();
    const target = ctx.corpus.agora.topics[0]!;
    const urls = [`/agora/t/${target.id}`, `/agora/t/${target.id}.json`];
    const before = await Promise.all(urls.map((u) => request(app).get(u).expect(200)));
    const posts = target.posts.length;
    // Publish into the topic's category until this topic receives a post.
    while (target.posts.length === posts) await admin.publish(app, 'agora', 50, target.topic);
    for (const [i, url] of urls.entries()) {
      const after = await request(app).get(url).set('If-None-Match', before[i]!.headers.etag);
      expect(after.status).toBe(200);
      expect(after.headers.etag).not.toBe(before[i]!.headers.etag);
    }
  });

  it('serves robots.txt, a sitemap and a forbidden admin area', async () => {
    const { app } = boot();
    const robots = await request(app).get('/agora/robots.txt').expect(200);
    expect(robots.text).toContain('Disallow: /agora/admin/');
    expect(robots.text).toContain('Crawl-delay: 1');
    const sitemap = await request(app).get('/agora/sitemap.xml').expect(200);
    expect(count(sitemap.text, '<url>')).toBe(800);
    expect(sitemap.text).toMatch(/<loc>http:\/\/[^<]+\/agora\/t\/at_000001<\/loc><lastmod>[^<]+Z<\/lastmod>/);
    await request(app).get('/agora/admin/').expect(403);
  });

  it('rate-limits per IP with Retry-After: 1', async () => {
    const { app } = boot({ AGORA_RATE: '10' });
    const results = await Promise.all(Array.from({ length: 15 }, () => request(app).get('/agora/robots.txt')));
    const limited = results.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    expect(limited[0]!.headers['retry-after']).toBe('1');
    expect(limited[0]!.headers['content-type']).toMatch(/html/);
  });
});
