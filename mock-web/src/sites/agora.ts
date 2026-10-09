import { Router, type Request, type Response } from 'express';
import type { Ctx } from '../context.js';
import { escapeHtml, iso } from '../lib/format.js';
import { qs, sendWithEtag } from '../lib/http.js';
import { chaos } from '../middleware/chaos.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { byNewest } from '../seed/generate.js';
import type { AgoraPost, AgoraTopic } from '../seed/types.js';

const TOPICS_PER_PAGE = 30;
const POSTS_PER_PAGE = 20;

export function agoraRouter(ctx: Ctx): Router {
  const r = Router();
  const settings = () => ctx.state.chaos.agora;

  r.use(chaos(ctx, 'agora'));
  r.use(
    rateLimit(ctx, {
      key: (req) => `agora:${req.ip}`,
      limit: () => ctx.config.agora.rate,
      windowMs: 1000,
      reject: (res) => {
        res
          .set('Retry-After', '1')
          .status(429)
          .type('html')
          .send('<!doctype html><html><head><title>Too many requests</title></head><body><h1>Too many requests</h1><p>Please slow down.</p></body></html>');
      },
    }),
  );

  r.get('/robots.txt', (req, res) => {
    sendWithEtag(req, res, 'text/plain', 'User-agent: *\nDisallow: /agora/admin/\nCrawl-delay: 1\nSitemap: /agora/sitemap.xml\n');
  });

  r.get('/sitemap.xml', (req, res) => {
    const origin = `${req.protocol}://${req.get('host')}`;
    const urls = ctx.corpus.agora.topics
      .map((t) => `  <url><loc>${origin}/agora/t/${t.id}</loc><lastmod>${iso(t.lastPosted)}</lastmod></url>`)
      .join('\n');
    sendWithEtag(
      req,
      res,
      'application/xml',
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    );
  });

  r.get('/admin', (_req, res) => {
    res.status(403).type('html').send(page('Forbidden', '<h1>Forbidden</h1><p>Staff only.</p>'));
  });

  r.get('/', (req, res) => {
    const items = ctx.corpus.agora.categories
      .map((c) => {
        const n = ctx.corpus.agora.topics.filter((t) => t.category === c.slug).length;
        return `<li class="category"><a class="category-link" href="/agora/c/${c.slug}">${escapeHtml(c.name)}</a> <span class="category-topics">${n} topics</span></li>`;
      })
      .join('\n');
    sendWithEtag(req, res, 'html', page('Categories', `<h1>Categories</h1>\n<ul class="category-list">\n${items}\n</ul>`));
  });

  const topicList = (req: Request, res: Response, json: boolean, category: string | null, heading: string, basePath: string) => {
    const pageNo = pageParam(req);
    const all = settings().emptyResults
      ? []
      : ctx.corpus.agora.topics.filter((t) => category === null || t.category === category).sort(byActivity);
    const slice = pageNo === null ? [] : all.slice((pageNo - 1) * TOPICS_PER_PAGE, pageNo * TOPICS_PER_PAGE);
    if (pageNo === null || (pageNo > 1 && slice.length === 0)) return notFound(res, json);
    const hasNext = pageNo * TOPICS_PER_PAGE < all.length;

    if (json) {
      return sendWithEtag(
        req,
        res,
        'application/json',
        JSON.stringify({
          category,
          page: pageNo,
          per_page: TOPICS_PER_PAGE,
          total_topics: all.length,
          topics: slice.map((t) => ({
            id: t.id,
            slug: t.slug,
            title: t.title,
            posts_count: t.posts.length,
            created_at: iso(t.created),
            last_posted_at: iso(t.lastPosted),
          })),
        }),
      );
    }
    const rows = slice
      .map(
        (t) =>
          `<tr class="topic-row" data-topic-id="${t.id}"><td><a class="topic-title" href="/agora/t/${t.id}">${escapeHtml(t.title)}</a></td>` +
          `<td class="topic-replies">${t.posts.length - 1}</td><td><time datetime="${iso(t.lastPosted)}">${shortDate(t.lastPosted)}</time></td></tr>`,
      )
      .join('\n');
    const next = hasNext ? `<a class="next-page" rel="next" href="${basePath}?page=${pageNo + 1}">Next page</a>` : '';
    sendWithEtag(
      req,
      res,
      'html',
      page(
        heading,
        `<h1>${escapeHtml(heading)}</h1>\n<table class="topic-list">\n<thead><tr><th>Topic</th><th>Replies</th><th>Activity</th></tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>\n<nav class="pagination">${next}</nav>`,
      ),
    );
  };

  r.get('/latest', (req, res) => topicList(req, res, false, null, 'Latest', '/agora/latest'));
  r.get('/latest.json', (req, res) => topicList(req, res, true, null, 'Latest', '/agora/latest'));

  r.get('/c/:slug', (req, res) => {
    const { name, json } = splitJson(req.params.slug as string);
    const category = ctx.corpus.agora.categories.find((c) => c.slug === name);
    if (!category) return notFound(res, json);
    topicList(req, res, json, category.slug, category.name, `/agora/c/${category.slug}`);
  });

  r.get('/t/:id', (req, res) => {
    const { name, json } = splitJson(req.params.id as string);
    const topic = ctx.corpus.agora.topicById.get(name);
    const pageNo = pageParam(req);
    if (!topic || pageNo === null) return notFound(res, json);
    const slice = topic.posts.slice((pageNo - 1) * POSTS_PER_PAGE, pageNo * POSTS_PER_PAGE);
    if (slice.length === 0) return notFound(res, json);
    const hasNext = pageNo * POSTS_PER_PAGE < topic.posts.length;
    const v2 = settings().layoutVersion === 2;

    if (json) {
      return sendWithEtag(
        req,
        res,
        'application/json',
        JSON.stringify({
          id: topic.id,
          title: topic.title,
          category: topic.category,
          posts_count: topic.posts.length,
          page: pageNo,
          per_page: POSTS_PER_PAGE,
          posts: slice.map((p) => ({
            id: p.id,
            post_number: p.postNumber,
            username: p.username,
            created_at: iso(p.created),
            [v2 ? 'html' : 'cooked']: p.cooked,
          })),
        }),
      );
    }
    const bodyClass = v2 ? 'post-content' : 'post-body';
    const posts = slice.map((p) => postHtml(p, bodyClass)).join('\n');
    const next = hasNext ? `<a class="next-page" rel="next" href="/agora/t/${topic.id}?page=${pageNo + 1}">Next page</a>` : '';
    const category = ctx.corpus.agora.categories.find((c) => c.slug === topic.category)!;
    sendWithEtag(
      req,
      res,
      'html',
      page(
        topic.title,
        `<p class="breadcrumb"><a href="/agora/c/${category.slug}">${escapeHtml(category.name)}</a></p>\n<h1 class="topic-heading">${escapeHtml(topic.title)}</h1>\n<p class="topic-meta"><span class="topic-posts">${topic.posts.length} posts</span></p>\n<section class="posts">\n${posts}\n</section>\n<nav class="pagination">${next}</nav>`,
      ),
    );
  });

  r.use((req, res) => notFound(res, req.path.endsWith('.json')));
  return r;
}

function byActivity(a: AgoraTopic, b: AgoraTopic): number {
  return byNewest({ created: a.lastPosted, id: a.id }, { created: b.lastPosted, id: b.id });
}

function postHtml(p: AgoraPost, bodyClass: string): string {
  return (
    `<article class="post" data-post-id="${p.id}" data-post-number="${p.postNumber}">\n` +
    `<header><span class="post-author">${escapeHtml(p.username)}</span> <time datetime="${iso(p.created)}">${shortDate(p.created)}</time></header>\n` +
    `<div class="${bodyClass}">${p.cooked}</div>\n</article>`
  );
}

function splitJson(param: string): { name: string; json: boolean } {
  return param.endsWith('.json') ? { name: param.slice(0, -5), json: true } : { name: param, json: false };
}

/** Page number from ?page=, or null when invalid. */
function pageParam(req: Request): number | null {
  if (req.query.page === undefined) return 1;
  const v = qs(req, 'page');
  if (v === undefined || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 ? n : null;
}

function notFound(res: Response, json: boolean): void {
  if (json) res.status(404).json({ error: 'not_found' });
  else res.status(404).type('html').send(page('Not found', '<h1>Not found</h1><p>That page does not exist.</p>'));
}

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function page(title: string, main: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - Agora</title>
</head>
<body>
<header class="site-header"><a class="site-logo" href="/agora/">Agora</a> <a href="/agora/latest">Latest</a></header>
<main>
${main}
</main>
</body>
</html>
`;
}
