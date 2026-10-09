import { randomBytes } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import type { Ctx } from '../context.js';
import { HttpError, badRequest, bearer, intParam, notFound, qs } from '../lib/http.js';
import { chaos } from '../middleware/chaos.js';
import { rateLimit } from '../middleware/rateLimit.js';
import type { ThreaditComment, ThreaditPost } from '../seed/types.js';

const RATE_WINDOW_MS = 60_000;

export function threaditRouter(ctx: Ctx): Router {
  const r = Router();
  const layout = () => ctx.state.chaos.threadit.layoutVersion;
  const empty = () => ctx.state.chaos.threadit.emptyResults;

  r.use(chaos(ctx, 'threadit'));

  r.post('/api/v1/access_token', express.urlencoded({ extended: false }), (req, res) => {
    const creds = parseBasic(req.get('authorization'));
    const { clientId, clientSecret, tokenTtl } = ctx.config.threadit;
    if (!creds || creds.id !== clientId || creds.secret !== clientSecret) {
      throw new HttpError(401, { error: 'invalid_client' });
    }
    if (req.body?.grant_type !== 'client_credentials') throw badRequest('grant_type');
    const token = randomBytes(20).toString('hex');
    ctx.state.tokens.set(token, ctx.clock.now() + tokenTtl * 1000);
    res.json({ access_token: token, token_type: 'bearer', expires_in: tokenTtl });
  });

  r.use((req, res, next) => {
    const token = bearer(req);
    const expires = token === undefined ? undefined : ctx.state.tokens.get(token);
    if (token === undefined || expires === undefined || expires <= ctx.clock.now()) {
      if (token !== undefined && expires !== undefined) ctx.state.tokens.delete(token);
      throw new HttpError(401, { error: 'invalid_token' });
    }
    res.locals.token = token;
    next();
  });

  r.use(
    rateLimit(ctx, {
      key: (_req, res) => `threadit:${res.locals.token as string}`,
      limit: () => ctx.config.threadit.rate,
      windowMs: RATE_WINDOW_MS,
      headers: (res, info) =>
        res.set({
          'X-Ratelimit-Used': String(info.used),
          'X-Ratelimit-Remaining': String(info.remaining),
          'X-Ratelimit-Reset': String(Math.ceil(info.resetMs / 1000)),
        }),
      reject: (res, info) => {
        const seconds = Math.max(1, Math.ceil(info.resetMs / 1000));
        res.set('Retry-After', String(seconds)).status(429).json({ error: 'rate_limited', retry_after: seconds });
      },
    }),
  );

  const listing = (req: Request, res: Response, match?: (p: ThreaditPost) => boolean) => {
    const { threadit } = ctx.corpus;
    const community = req.params.community as string;
    if (!threadit.communities.includes(community)) throw notFound();
    const limit = intParam(req, 'limit', 1, 100, 25);
    const afterId = qs(req, 'after');
    let cursor: ThreaditPost | undefined;
    if (req.query.after !== undefined) {
      cursor = afterId === undefined ? undefined : threadit.postById.get(afterId);
      if (!cursor || cursor.community !== community) throw badRequest('after');
    }
    if (empty()) return void res.json({ data: { children: [], after: null } });

    // Cursor = the last item seen; the next page is everything strictly older, so
    // newly published posts (always newest) never shift it.
    const page: ThreaditPost[] = [];
    let more = false;
    for (const p of threadit.posts) {
      if (p.community !== community) continue;
      if (cursor && !(p.created < cursor.created || (p.created === cursor.created && p.id < cursor.id))) continue;
      if (match && !match(p)) continue;
      if (page.length === limit) {
        more = true;
        break;
      }
      page.push(p);
    }
    res.json({ data: { children: page.map((p) => postJson(p, layout())), after: more ? page[page.length - 1]!.id : null } });
  };

  r.get('/c/:community/new', (req, res) => listing(req, res));

  r.get('/c/:community/search', (req, res) => {
    const q = qs(req, 'q');
    if (!q) throw badRequest('q');
    const needle = q.toLowerCase();
    listing(req, res, (p) => p.title.toLowerCase().includes(needle) || p.body.toLowerCase().includes(needle));
  });

  r.get('/posts/:id/comments', (req, res) => {
    const post = ctx.corpus.threadit.postById.get(req.params.id as string);
    if (!post) throw notFound();
    const limit = intParam(req, 'limit', 1, 100, 25);
    let start = 0;
    if (req.query.after !== undefined) {
      const afterId = qs(req, 'after');
      const i = afterId === undefined ? -1 : post.comments.findIndex((c) => c.id === afterId);
      if (i < 0) throw badRequest('after');
      start = i + 1;
    }
    if (empty()) return void res.json({ data: { children: [], after: null } });
    const page = post.comments.slice(start, start + limit);
    const more = start + limit < post.comments.length;
    res.json({ data: { children: page.map(commentJson), after: more ? page[page.length - 1]!.id : null } });
  });

  r.use(() => {
    throw notFound();
  });
  return r;
}

function postJson(p: ThreaditPost, layout: number) {
  const data: Record<string, unknown> = { id: p.id, community: p.community, title: p.title };
  data[layout === 2 ? 'body_text' : 'selftext'] = p.body;
  Object.assign(data, {
    author: p.author,
    created_utc: p.created / 1000,
    score: p.score,
    num_comments: p.comments.length,
    permalink: `/threadit/c/${p.community}/posts/${p.id}`,
  });
  return { kind: 't3', data };
}

function commentJson(c: ThreaditComment) {
  return {
    kind: 't1',
    data: { id: c.id, post_id: c.postId, body: c.body, author: c.author, created_utc: c.created / 1000, score: c.score },
  };
}

function parseBasic(header: string | undefined): { id: string; secret: string } | undefined {
  const m = /^Basic\s+(\S+)$/i.exec(header ?? '');
  if (!m) return undefined;
  const decoded = Buffer.from(m[1] as string, 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  return i < 0 ? undefined : { id: decoded.slice(0, i), secret: decoded.slice(i + 1) };
}
