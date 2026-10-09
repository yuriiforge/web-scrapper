import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { BROWSER, admin, boot, count, ratewellData, ratewellSession } from './helpers.js';

const SLUG = 'voltra-motors';

describe('ratewell', () => {
  it('lists the 40 companies as server-rendered links', async () => {
    const { app } = boot();
    const res = await request(app).get('/ratewell/').set(BROWSER).expect(200);
    expect(count(res.text, 'class="company-link"')).toBe(40);
  });

  it('serves an empty shell with zero reviews to a plain GET', async () => {
    const { app } = boot();
    const res = await request(app).get(`/ratewell/company/${SLUG}`).set(BROWSER).expect(200);
    expect(count(res.text, 'class="review"')).toBe(0);
    expect(res.text).toContain(`<div id="reviews" data-slug="${SLUG}"></div>`);
    expect(res.text).toContain('<button id="load-more"');
    expect(res.text).toMatch(/window\.__RW = \{nonce: "[0-9a-f]{32}"\};/);
    expect(res.text).toContain('<script src="/ratewell/static/app.js"></script>');
    expect(res.headers['set-cookie']?.[0]).toMatch(/^rw_sid=[0-9a-f]+; Path=\/ratewell; SameSite=Lax$/);

    const again = await request(app).get(`/ratewell/company/${SLUG}`).set(BROWSER).expect(200);
    expect(/nonce: "(\w+)"/.exec(again.text)![1]).not.toBe(/nonce: "(\w+)"/.exec(res.text)![1]);
  });

  it('serves app.js to browsers', async () => {
    const { app } = boot();
    const res = await request(app).get('/ratewell/static/app.js').set(BROWSER).expect(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.text).toContain('X-RW-Token');
    expect(res.text).not.toMatch(/crypto\.subtle\./);
  });

  it('returns reviews for a valid session and token', async () => {
    const { app } = boot();
    const s = await ratewellSession(app, SLUG);
    const res = await ratewellData(app, SLUG, s).expect(200);
    expect(res.body).toMatchObject({
      company: { slug: SLUG, name: 'Voltra Motors', topic: 'electric cars' },
      page: 1,
      page_size: 20,
      total: 150,
      has_more: true,
    });
    expect(res.body.reviews).toHaveLength(20);
    expect(Object.keys(res.body.reviews[0])).toEqual(['id', 'rating', 'title', 'body', 'author', 'country', 'created_at', 'verified']);
    const last = await ratewellData(app, SLUG, s, 8).expect(200);
    expect(last.body.reviews).toHaveLength(10);
    expect(last.body.has_more).toBe(false);
    await ratewellData(app, SLUG, s, 9).expect(404);
  });

  it('rejects a wrong token with 403 bad_token', async () => {
    const { app } = boot();
    const s = await ratewellSession(app, SLUG);
    const res = await ratewellData(app, SLUG, { ...s, token: '00000000' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'bad_token' });
    const otherSid = await ratewellData(app, SLUG, { ...s, cookie: 'rw_sid=0123456789abcdef0123456789abcdef' });
    expect(otherSid.body).toEqual({ error: 'bad_token' });
  });

  it('rejects a nonce older than 10 minutes', async () => {
    const { app, ctx } = boot();
    const s = await ratewellSession(app, SLUG);
    ctx.clock.offsetMs += 10 * 60_000 + 1000;
    expect((await ratewellData(app, SLUG, s)).body).toEqual({ error: 'bad_token' });
  });

  it('shows the challenge page with X-RW-Block: ua to curl', async () => {
    const { app } = boot();
    for (const url of [`/ratewell/company/${SLUG}`, `/ratewell/_data/company/${SLUG}/reviews`]) {
      const res = await request(app).get(url).set({ ...BROWSER, 'User-Agent': 'curl/8.4.0' });
      expect(res.status).toBe(403);
      expect(res.headers['x-rw-block']).toBe('ua');
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.text).toContain('<title>Checking your browser</title>');
      expect(res.text).toContain('<div id="rw-challenge">');
    }
    const noLang = await request(app).get('/ratewell/').set('User-Agent', BROWSER['User-Agent']);
    expect(noLang.headers['x-rw-block']).toBe('ua');
  });

  it('lets anything through at level 0', async () => {
    const { app } = boot();
    await admin.chaos(app, 'ratewell', { botCheckLevel: 0 });
    await request(app).get('/ratewell/').set('User-Agent', 'python-requests/2.32').expect(200);
  });

  it('blocks a session at level 2 once it has sent X-RW-Webdriver: 1', async () => {
    const { app } = boot();
    await admin.chaos(app, 'ratewell', { botCheckLevel: 2 });
    const s = await ratewellSession(app, SLUG);
    await ratewellData(app, SLUG, s).expect(200);
    await ratewellData(app, SLUG, s).set('X-RW-Webdriver', '1');
    const next = await ratewellData(app, SLUG, s);
    expect(next.status).toBe(403);
    expect(next.headers['x-rw-block']).toBe('webdriver');
    expect(next.text).toContain('rw-challenge');
  });

  it('blocks everything not via PassGate at level 3', async () => {
    const { app } = boot();
    await admin.chaos(app, 'ratewell', { botCheckLevel: 3 });
    const res = await request(app).get('/ratewell/').set(BROWSER);
    expect(res.status).toBe(403);
    expect(res.headers['x-rw-block']).toBe('forced');
  });

  it('blocks a session for 300 s after more than RATEWELL_RATE data requests in 60 s', async () => {
    const { app, ctx } = boot({ RATEWELL_RATE: '5' });
    const s = await ratewellSession(app, SLUG);
    for (let i = 0; i < 5; i++) await ratewellData(app, SLUG, s).expect(200);
    const sixth = await ratewellData(app, SLUG, s);
    expect(sixth.status).toBe(403);
    expect(sixth.headers['x-rw-block']).toBe('rate');
    ctx.clock.offsetMs += 120_000;
    expect((await request(app).get(`/ratewell/company/${SLUG}`).set(BROWSER).set('Cookie', s.cookie)).headers['x-rw-block']).toBe('rate');
    ctx.clock.offsetMs += 181_000;
    const fresh = await ratewellSession(app, SLUG, s.cookie);
    await ratewellData(app, SLUG, fresh).expect(200);
  });
});
