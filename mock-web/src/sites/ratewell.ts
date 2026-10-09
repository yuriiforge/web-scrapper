import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Router, type RequestHandler, type Response } from 'express';
import type { Ctx } from '../context.js';
import { escapeHtml, iso } from '../lib/format.js';
import { HttpError, badRequest, notFound, parseCookies, qs } from '../lib/http.js';
import { fnv1aHex } from '../lib/rng.js';
import { chaos } from '../middleware/chaos.js';
import { hit } from '../middleware/rateLimit.js';
import type { Company, Review } from '../seed/types.js';
import type { RatewellSession } from '../state.js';

export const PAGE_SIZE = 20;
/** Header PassGate sets (with the internal marker) to get a page with reviews pre-rendered. */
export const RENDER_HEADER = 'x-passgate-render';

const APP_JS = fileURLToPath(new URL('../../public/ratewell/app.js', import.meta.url));
const NONCE_TTL_MS = 10 * 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_BLOCK_MS = 300_000;
const BOT_UA = /headless|python|curl|node|axios|playwright/i;

type BlockReason = 'ua' | 'webdriver' | 'rate' | 'forced';

export function ratewellRouter(ctx: Ctx): Router {
  const r = Router();
  const settings = () => ctx.state.chaos.ratewell;

  r.use(chaos(ctx, 'ratewell'));
  r.use(botCheck(ctx));

  r.get('/', (_req, res) => {
    const groups = new Map<string, Company[]>();
    for (const c of ctx.corpus.ratewell.companies) groups.set(c.topic, [...(groups.get(c.topic) ?? []), c]);
    const sections = [...groups]
      .map(
        ([topic, companies]) =>
          `<section class="topic"><h2>${escapeHtml(topic)}</h2><ul>\n` +
          companies.map((c) => `<li><a class="company-link" href="/ratewell/company/${c.slug}">${escapeHtml(c.name)}</a></li>`).join('\n') +
          `\n</ul></section>`,
      )
      .join('\n');
    res.type('html').send(page('Ratewell - honest company reviews', `<h1>Companies</h1>\n${sections}`));
  });

  r.get('/static/app.js', (_req, res) => {
    res.type('application/javascript').sendFile(APP_JS);
  });

  r.get('/company/:slug', (req, res) => {
    const company = ctx.corpus.ratewell.companyBySlug.get(req.params.slug as string);
    if (!company) throw new HttpError(404, { error: 'not_found' });

    let sid = parseCookies(req.get('cookie')).rw_sid;
    if (!sid || !/^[0-9a-f]{16,64}$/.test(sid)) {
      sid = randomBytes(16).toString('hex');
      res.cookie('rw_sid', sid, { path: '/ratewell', sameSite: 'lax' });
    }
    const session = getSession(ctx, sid);
    const nonce = randomBytes(16).toString('hex');
    session.nonces.set(nonce, ctx.clock.now());
    if (session.nonces.size > 50) session.nonces.delete(session.nonces.keys().next().value as string);

    let prefilled: { reviews: Review[]; hasMore: boolean } | undefined;
    const renderPage = req.get(RENDER_HEADER);
    if (res.locals.viaPassGate && renderPage) {
      const p = reviewsPage(ctx, company, Number(renderPage) || 1);
      prefilled = { reviews: p.reviews, hasMore: p.hasMore };
    }
    res.type('html').send(companyPage(company, nonce, settings().layoutVersion, prefilled));
  });

  r.get('/_data/company/:slug/reviews', tokenCheck(ctx), sessionRateLimit(ctx), (req, res) => {
    const company = ctx.corpus.ratewell.companyBySlug.get(req.params.slug as string);
    if (!company) throw notFound();
    let pageNo = 1;
    if (req.query.page !== undefined) {
      const v = qs(req, 'page');
      if (v === undefined || !/^\d+$/.test(v) || Number(v) < 1) throw badRequest('page');
      pageNo = Number(v);
    }
    const p = reviewsPage(ctx, company, pageNo);
    if (pageNo > 1 && p.reviews.length === 0) throw notFound();
    const v2 = settings().layoutVersion === 2;
    res.json({
      company: { slug: company.slug, name: company.name, topic: company.topic },
      page: pageNo,
      page_size: PAGE_SIZE,
      total: p.total,
      has_more: p.hasMore,
      [v2 ? 'items' : 'reviews']: p.reviews.map((rv) => ({
        id: rv.id,
        rating: v2 ? `${rv.rating}/5` : rv.rating,
        title: rv.title,
        body: rv.body,
        author: rv.author,
        country: rv.country,
        created_at: iso(rv.created),
        verified: rv.verified,
      })),
    });
  });

  r.use(() => {
    throw notFound();
  });

  return r;
}

function getSession(ctx: Ctx, sid: string): RatewellSession {
  let s = ctx.state.sessions.get(sid);
  if (!s) {
    s = { nonces: new Map(), webdriver: false, blockedUntil: 0 };
    ctx.state.sessions.set(sid, s);
  }
  return s;
}

export function reviewsPage(ctx: Ctx, company: Company, pageNo: number): { reviews: Review[]; total: number; hasMore: boolean } {
  const all = ctx.state.chaos.ratewell.emptyResults ? [] : company.reviews;
  return {
    reviews: all.slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE),
    total: all.length,
    hasMore: pageNo * PAGE_SIZE < all.length,
  };
}

/** Bot checks for every Ratewell request; PassGate requests always pass. */
function botCheck(ctx: Ctx): RequestHandler {
  return (req, res, next) => {
    const level = ctx.state.chaos.ratewell.botCheckLevel ?? 1;
    const sid = parseCookies(req.get('cookie')).rw_sid;
    const session = sid ? ctx.state.sessions.get(sid) : undefined;
    if (session && req.get('x-rw-webdriver') === '1') session.webdriver = true;
    if (res.locals.viaPassGate) return next();

    if (level >= 3) return block(res, 'forced');
    if (level >= 1) {
      const ua = req.get('user-agent');
      if (!req.get('accept-language') || !ua || BOT_UA.test(ua)) return block(res, 'ua');
    }
    if (level >= 2 && session?.webdriver) return block(res, 'webdriver');
    if (session && session.blockedUntil > ctx.clock.now()) return block(res, 'rate');
    next();
  };
}

/** The nonce must have been issued to this rw_sid in the last 10 minutes, and the token must match. */
function tokenCheck(ctx: Ctx): RequestHandler {
  return (req, res, next) => {
    if (res.locals.viaPassGate) return next();
    const sid = parseCookies(req.get('cookie')).rw_sid;
    const nonce = req.get('x-rw-nonce');
    const token = req.get('x-rw-token');
    const session = sid ? ctx.state.sessions.get(sid) : undefined;
    const issued = nonce ? session?.nonces.get(nonce) : undefined;
    const ok =
      sid !== undefined &&
      issued !== undefined &&
      ctx.clock.now() - issued <= NONCE_TTL_MS &&
      token?.toLowerCase() === fnv1aHex(`${nonce}:${sid}`);
    if (!ok) return void res.status(403).json({ error: 'bad_token' });
    res.locals.rwSid = sid;
    next();
  };
}

/** More than RATEWELL_RATE data requests in 60 s blocks the session for 300 s. */
function sessionRateLimit(ctx: Ctx): RequestHandler {
  return (_req, res, next) => {
    if (res.locals.viaPassGate) return next();
    const sid = res.locals.rwSid as string;
    const now = ctx.clock.now();
    const info = hit(ctx.state.buckets, `ratewell:${sid}`, ctx.config.ratewell.rate, RATE_WINDOW_MS, now);
    if (!info.allowed) {
      getSession(ctx, sid).blockedUntil = now + RATE_BLOCK_MS;
      return block(res, 'rate');
    }
    next();
  };
}

function block(res: Response, reason: BlockReason): void {
  res
    .status(403)
    .set('X-RW-Block', reason)
    .type('html')
    .send(
      '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Checking your browser</title></head>\n' +
        '<body>\n<div id="rw-challenge"><h1>Checking your browser&hellip;</h1>' +
        '<p>This request looked automated. Enable JavaScript and cookies, then reload the page.</p></div>\n</body>\n</html>\n',
    );
}

/** Same markup app.js builds for a review. */
export function reviewHtml(rv: Review, layout: number): string {
  const bodyClass = layout === 2 ? 'rv-text' : 'review-body';
  return (
    `<article class="review" data-id="${rv.id}">` +
    `<div class="review-rating" data-rating="${rv.rating}">${rv.rating}/5</div>` +
    `<h3 class="review-title">${escapeHtml(rv.title)}</h3>` +
    `<p class="${bodyClass}">${escapeHtml(rv.body)}</p>` +
    `<footer><span class="review-author">${escapeHtml(rv.author)}</span> <span class="review-country">${rv.country}</span> ` +
    `<time datetime="${iso(rv.created)}">${iso(rv.created).slice(0, 10)}</time></footer>` +
    `</article>`
  );
}

function companyPage(company: Company, nonce: string, layout: number, prefilled?: { reviews: Review[]; hasMore: boolean }): string {
  const reviews = prefilled ? prefilled.reviews.map((rv) => reviewHtml(rv, layout)).join('') : '';
  const button = !prefilled || prefilled.hasMore ? '<button id="load-more" type="button">Load more</button>' : '';
  return page(
    `${company.name} reviews - Ratewell`,
    `<h1 class="company-name">${escapeHtml(company.name)}</h1>\n<p class="company-topic">${escapeHtml(company.topic)}</p>\n` +
      `<div id="reviews" data-slug="${company.slug}">${reviews}</div>\n${button}\n` +
      `<script>window.__RW = {nonce: "${nonce}"};</script>\n<script src="/ratewell/static/app.js"></script>`,
  );
}

function page(title: string, main: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:46rem;margin:0 auto;padding:1rem;color:#1d2330}
.review{border-bottom:1px solid #dde;padding:.75rem 0}.review-rating{font-weight:600;color:#b4690e}
.review footer{font-size:.85rem;color:#667}#load-more{margin:1rem 0;padding:.5rem 1rem}
</style>
</head>
<body>
<header><a href="/ratewell/">Ratewell</a></header>
<main>
${main}
</main>
</body>
</html>
`;
}
