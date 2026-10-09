import type { ThreaditConfig } from '@lp/shared';
import type { z } from 'zod';
import { CollectorError, assertOk } from '../errors';
import type { HttpResponse } from '../http';
import type { Collector, CollectorDeps, FetchResult, ParsedItem, RawResponse, RunContext } from '../types';
import { comment, listing, post, tokenResponse, type Post } from './schemas';

const COUNTRY_COMMUNITIES = new Set(['gb', 'de', 'fr', 'us', 'pl', 'ua']);
const LISTING_URL = /\/threadit\/c\/([a-z0-9_]+)\/new(\?|$)/;
const COMMENTS_URL = /\/threadit\/posts\/([^/?]+)\/comments(\?|$)/;

export interface ThreaditState {
  after: string | null;
  page: number;
}

/** The newest post seen so far; the next run stops when it reaches it. */
export interface ThreaditCheckpoint {
  createdUtc: number;
  id: string;
}

/**
 * Official-API collector for Threadit (stands in for Reddit). Strategy `api`: cheaper and
 * steadier than scraping HTML, and the API gives cursors and rate-limit headers.
 */
export class ThreaditCollector implements Collector<ThreaditState, ThreaditCheckpoint> {
  readonly site = 'threadit' as const;
  readonly strategy = 'api' as const;
  /** Default is below the site's published 60 per minute, so the limiter rather than a 429 sets the pace. */
  get ratePerMinute(): number {
    return this.config.ratePerMinute ?? 50;
  }

  private token: { value: string; refreshAt: number } | undefined;
  private since: ThreaditCheckpoint | null = null;
  private newest: ThreaditCheckpoint | null = null;

  constructor(
    private readonly config: ThreaditConfig,
    private readonly deps: CollectorDeps,
  ) {}

  initialState(checkpoint: ThreaditCheckpoint | null): ThreaditState {
    this.since = checkpoint;
    this.newest = checkpoint;
    return { after: null, page: 0 };
  }

  checkpoint(): ThreaditCheckpoint | null {
    return this.newest;
  }

  async fetchPage(ctx: RunContext, state: ThreaditState): Promise<FetchResult<ThreaditState>> {
    const { community, pageSize, includeComments, maxPages } = this.config;
    const url = this.url(`/threadit/c/${community}/new`, { limit: String(pageSize), after: state.after ?? undefined });
    const res = await this.get(ctx, url);
    const page = this.decode(res, listing(post));
    const posts = page.data.children.map((c) => c.data);

    // Listings are newest first: once a post is not newer than the checkpoint, nothing after it is.
    const fresh = posts.filter((p) => isNewer(p, this.since));
    for (const p of fresh) if (isNewer(p, this.newest)) this.newest = { createdUtc: p.created_utc, id: p.id };

    const responses: RawResponse[] = [res];
    if (includeComments) {
      for (const p of fresh) if (p.num_comments > 0) responses.push(...(await this.fetchComments(ctx, p.id)));
    }

    const pageNo = state.page + 1;
    const reachedCheckpoint = fresh.length < posts.length;
    const hitMaxPages = maxPages !== undefined && pageNo >= maxPages;
    const next = page.data.after && !reachedCheckpoint && !hitMaxPages ? { after: page.data.after, page: pageNo } : null;
    ctx.log.debug({ page: pageNo, posts: posts.length, fresh: fresh.length, done: next === null }, 'threadit page');
    return { responses, next };
  }

  parse(raw: RawResponse): ParsedItem[] {
    const listingMatch = LISTING_URL.exec(raw.url);
    if (listingMatch) {
      const community = listingMatch[1] as string;
      const country = COUNTRY_COMMUNITIES.has(community) ? community.toUpperCase() : null;
      return this.decode(raw, listing(post)).data.children.map(({ data: p }) => ({
        externalId: p.id,
        author: p.author,
        text: p.selftext ? `${p.title}\n\n${p.selftext}` : p.title,
        country,
        publishedAt: new Date(p.created_utc * 1000),
      }));
    }
    if (COMMENTS_URL.test(raw.url)) {
      // A comment's community says where it was posted, not where its author lives; country stays unknown.
      return this.decode(raw, listing(comment)).data.children.map(({ data: c }) => ({
        externalId: c.id,
        author: c.author,
        text: c.body,
        country: null,
        publishedAt: new Date(c.created_utc * 1000),
      }));
    }
    throw new CollectorError('parse', `no Threadit parser for ${raw.url}`);
  }

  private async fetchComments(ctx: RunContext, postId: string): Promise<RawResponse[]> {
    const out: RawResponse[] = [];
    let after: string | null = null;
    do {
      const res = await this.get(ctx, this.url(`/threadit/posts/${postId}/comments`, { limit: '100', after: after ?? undefined }));
      out.push(res);
      after = this.decode(res, listing(comment)).data.after;
    } while (after);
    return out;
  }

  /** GET with a bearer token. A 401 refreshes the token once; a second 401 fails the run as `auth`. */
  private async get(ctx: RunContext, url: string): Promise<HttpResponse> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken(ctx);
      const res = await ctx.http.request({ url, headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
      if (res.status === 401 && attempt === 0) {
        ctx.log.info({ url }, 'token rejected, refreshing');
        this.token = undefined;
        continue;
      }
      assertOk(res);
      await this.respectRateLimit(ctx, res);
      return res;
    }
  }

  /** When the window is used up, wait for it to reset instead of spending a request on a 429. */
  private async respectRateLimit(ctx: RunContext, res: HttpResponse): Promise<void> {
    const remaining = Number(res.headers['x-ratelimit-remaining']);
    const reset = Number(res.headers['x-ratelimit-reset']);
    if (remaining === 0 && reset > 0) {
      ctx.log.info({ resetSeconds: reset }, 'rate-limit window used up, waiting for reset');
      await ctx.sleep(reset * 1000 + 250, ctx.signal);
    }
  }

  private async accessToken(ctx: RunContext): Promise<string> {
    if (this.token && ctx.now() < this.token.refreshAt) return this.token.value;
    const { clientId, clientSecret } = this.deps.threadit;
    const res = await ctx.http.request({
      url: this.url('/threadit/api/v1/access_token'),
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (res.status === 401) throw new CollectorError('auth', 'Threadit rejected the client credentials', 401);
    assertOk(res);
    const t = this.decode(res, tokenResponse);
    // Refresh early: 30 s before expiry, or halfway through very short lifetimes.
    const margin = Math.min(30_000, (t.expires_in * 1000) / 2);
    this.token = { value: t.access_token, refreshAt: ctx.now() + t.expires_in * 1000 - margin };
    ctx.log.debug({ expiresIn: t.expires_in }, 'threadit token issued');
    return t.access_token;
  }

  /** JSON.parse + schema check. A failure carries the response, so the run keeps it for debugging. */
  private decode<T extends z.ZodType>(raw: RawResponse, schema: T): z.infer<T> {
    let json: unknown;
    try {
      json = JSON.parse(raw.body);
    } catch {
      throw new CollectorError('parse', `invalid JSON from ${raw.url}`, raw.status, [raw]);
    }
    const result = schema.safeParse(json);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new CollectorError('parse', `unexpected shape from ${raw.url} at ${issue?.path.join('.')}: ${issue?.message}`, raw.status, [raw]);
    }
    return result.data;
  }

  private url(path: string, query: Record<string, string | undefined> = {}): string {
    const u = new URL(path, this.deps.baseUrl);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  }
}

function isNewer(p: Pick<Post, 'created_utc' | 'id'>, than: ThreaditCheckpoint | null): boolean {
  if (!than) return true;
  return p.created_utc > than.createdUtc || (p.created_utc === than.createdUtc && p.id > than.id);
}
