import type { AgoraConfig } from '@lp/shared';
import { CollectorError, assertOk } from '../errors';
import type { HttpResponse } from '../http';
import { withTitle } from '../normalize';
import { ALLOW_ALL, isAllowed, parseRobots, type RobotsRules } from '../robots';
import type { Collector, CollectorDeps, FetchResult, ParsedItem, RawResponse, RunContext } from '../types';
import { parseListingHtml, parseListingJson, parseTopicHtml, parseTopicJson, type ListingPage, type TopicRef } from './parse';

const USER_AGENT_TOKEN = 'ListeningPost';
const ROBOTS_URL = /\/agora\/robots\.txt$/;
const SITEMAP_URL = /\/agora\/sitemap\.xml$/;
const LISTING_URL = /\/agora\/(c\/[a-z0-9-]+|latest)(\.json)?(\?|$)/;
const TOPIC_URL = /\/agora\/t\/([^/?.]+)(\.json)?(\?|$)/;

/** A topic to consider: its id and when it last had a post. Listings and the sitemap both give these. */
type TopicStub = Pick<TopicRef, 'id' | 'lastPostedAt'>;

export type AgoraState =
  | { mode: 'listing'; listPage: number; topicsFetched: number }
  | { mode: 'sitemap'; topics: TopicStub[] | null; offset: number; topicsFetched: number };

export interface AgoraCheckpoint {
  /** Every topic whose last post is at or before this time is stored. */
  watermark: string | null;
  /**
   * Topics last active within [from, to] were stored by a run that hit `maxTopics` before
   * reaching the watermark. The next run skips this band and continues with the backlog below it.
   */
  done: { from: string; to: string } | null;
  /** Rules from the last robots.txt read, reused when it answers 304. */
  robots: RobotsRules | null;
}

const SITEMAP_BATCH = 30;

/**
 * Forum collector for Agora (stands in for a public Discourse-style forum).
 *
 * Strategy `html`: no API keys, only public pages. It reads the same data from the hidden
 * `.json` endpoints by default, since they are smaller and change less than markup; `format: "html"`
 * parses the visible pages instead. Polite by design: robots.txt is obeyed (Disallow and
 * Crawl-delay), and unchanged pages cost a 304 thanks to stored ETags.
 */
export class AgoraCollector implements Collector<AgoraState, AgoraCheckpoint> {
  readonly site = 'agora' as const;
  readonly strategy = 'html' as const;
  /** Evenly spaced requests, never bursts: Crawl-delay is about spacing. */
  readonly burst = 1;

  private robots: RobotsRules | null = null;
  private since: string | null = null;
  private done: AgoraCheckpoint['done'] = null;
  private newest: string | null = null;
  /** last_posted_at of the last topic fetched this run; with a cap, the next run resumes below it. */
  private lastFetched: string | null = null;
  private capped = false;
  private lastRequestAt = 0;

  constructor(
    private readonly config: AgoraConfig,
    private readonly deps: CollectorDeps,
  ) {}

  get ratePerMinute(): number {
    return Math.min(this.config.ratePerMinute ?? 60, 60);
  }

  initialState(checkpoint: AgoraCheckpoint | null): AgoraState {
    this.since = checkpoint?.watermark ?? null;
    this.done = checkpoint?.done ?? null;
    this.newest = this.since;
    this.robots = checkpoint?.robots ?? null;
    // A first full crawl of every category reads the sitemap: one request lists every topic.
    // Later runs, and single-category sources, walk the listing sorted by latest activity.
    const firstCrawl = this.since === null && this.done === null;
    return firstCrawl && !this.config.category
      ? { mode: 'sitemap', topics: null, offset: 0, topicsFetched: 0 }
      : { mode: 'listing', listPage: 1, topicsFetched: 0 };
  }

  checkpoint(): AgoraCheckpoint {
    // Capped before the watermark: what lies between the old watermark and the last topic fetched
    // is still to do, so the watermark stays and the fetched band is remembered instead.
    if (this.capped && this.lastFetched && this.newest) {
      return { watermark: this.since, done: { from: this.lastFetched, to: this.newest }, robots: this.robots };
    }
    return { watermark: this.newest, done: null, robots: this.robots };
  }

  async fetchPage(ctx: RunContext, state: AgoraState): Promise<FetchResult<AgoraState>> {
    const responses: RawResponse[] = [];
    if (state.mode === 'sitemap' ? state.topics === null : state.listPage === 1) {
      const robots = await this.loadRobots(ctx);
      if (robots) responses.push(robots);
    }
    return state.mode === 'sitemap' ? this.sitemapPage(ctx, state, responses) : this.listingPage(ctx, state, responses);
  }

  private async listingPage(
    ctx: RunContext,
    state: Extract<AgoraState, { mode: 'listing' }>,
    responses: RawResponse[],
  ): Promise<FetchResult<AgoraState>> {
    // An unchanged first page means nothing new anywhere, unless a capped run left a backlog.
    const listing = await this.get(ctx, this.listingUrl(state.listPage), { conditional: this.done === null });
    if (listing.status === 304) {
      ctx.log.info({ page: state.listPage }, 'listing unchanged since last run');
      return { responses, next: null };
    }
    responses.push(listing);
    const page = this.parseListing(listing);
    ctx.listed(page.topics.length);
    const walked = await this.walk(ctx, page.topics, state.topicsFetched, responses);
    ctx.log.debug({ page: state.listPage, topics: page.topics.length, fetched: walked.fetched }, 'agora listing');
    const next = page.hasNext && !walked.stop ? { mode: 'listing' as const, listPage: state.listPage + 1, topicsFetched: state.topicsFetched + walked.fetched } : null;
    return { responses, next };
  }

  private async sitemapPage(
    ctx: RunContext,
    state: Extract<AgoraState, { mode: 'sitemap' }>,
    responses: RawResponse[],
  ): Promise<FetchResult<AgoraState>> {
    let topics = state.topics;
    if (topics === null) {
      const res = await this.get(ctx, this.url('/agora/sitemap.xml'), { conditional: false });
      responses.push(res);
      topics = parseSitemap(res).sort((a, b) => (a.lastPostedAt < b.lastPostedAt ? 1 : a.lastPostedAt > b.lastPostedAt ? -1 : 0));
      ctx.log.info({ topics: topics.length }, 'sitemap read');
      ctx.listed(topics.length);
    }
    const batch = topics.slice(state.offset, state.offset + SITEMAP_BATCH);
    const walked = await this.walk(ctx, batch, state.topicsFetched, responses);
    const offset = state.offset + batch.length;
    const next =
      offset < topics.length && !walked.stop
        ? { mode: 'sitemap' as const, topics, offset, topicsFetched: state.topicsFetched + walked.fetched }
        : null;
    return { responses, next };
  }

  /**
   * Goes through topics newest activity first: stops at the watermark, skips the band a capped run
   * already stored, fetches the rest until `maxTopics`. `stop` means nothing further is needed.
   */
  private async walk(
    ctx: RunContext,
    topics: TopicStub[],
    fetchedSoFar: number,
    responses: RawResponse[],
  ): Promise<{ fetched: number; stop: boolean }> {
    let fetched = 0;
    for (const t of topics) {
      if (!this.newest || t.lastPostedAt > this.newest) this.newest = t.lastPostedAt;
      if (this.since && t.lastPostedAt <= this.since) return { fetched, stop: true };
      if (this.done && t.lastPostedAt >= this.done.from && t.lastPostedAt <= this.done.to) continue;
      if (this.config.maxTopics !== undefined && fetchedSoFar + fetched >= this.config.maxTopics) {
        this.capped = true;
        return { fetched, stop: true };
      }
      responses.push(...(await this.fetchTopic(ctx, t)));
      this.lastFetched = t.lastPostedAt;
      fetched += 1;
    }
    return { fetched, stop: false };
  }

  parse(raw: RawResponse): ParsedItem[] {
    if (ROBOTS_URL.test(raw.url) || SITEMAP_URL.test(raw.url) || LISTING_URL.test(raw.url)) return [];
    const m = TOPIC_URL.exec(raw.url);
    if (!m) throw new CollectorError('parse', `no Agora parser for ${raw.url}`);
    const topic = m[2] ? parseTopicJson(raw) : parseTopicHtml(raw);
    return topic.posts.map((p) => ({
      externalId: p.id,
      author: p.username,
      // The opening post carries the topic title, as on Threadit.
      text: p.postNumber === 1 ? withTitle(topic.title, p.html) : p.html,
      country: null,
      publishedAt: new Date(p.createdAt),
    }));
  }

  private async fetchTopic(ctx: RunContext, topic: TopicStub): Promise<RawResponse[]> {
    const out: RawResponse[] = [];
    for (let page = 1; ; page++) {
      const res = await this.get(ctx, this.url(`/agora/t/${topic.id}${this.ext}`, { page: String(page) }));
      if (res.status === 304) break;
      out.push(res);
      const parsed = this.config.format === 'json' ? parseTopicJson(res) : parseTopicHtml(res);
      if (!parsed.hasNext) break;
    }
    return out;
  }

  /** Reads robots.txt; a 304 reuses the stored rules, a 404 allows everything. */
  private async loadRobots(ctx: RunContext): Promise<RawResponse | null> {
    const url = this.url('/agora/robots.txt');
    const res = await this.get(ctx, url, { conditional: this.robots !== null, checkRobots: false, allowMissing: true });
    if (res.status === 304) return null;
    this.robots = res.status === 404 ? ALLOW_ALL : parseRobots(res.body, USER_AGENT_TOKEN);
    ctx.log.info({ crawlDelay: this.robots.crawlDelaySeconds, disallow: this.robots.disallow }, 'robots.txt read');
    return res.status === 200 ? res : null;
  }

  private parseListing(raw: RawResponse): ListingPage {
    return this.config.format === 'json' ? parseListingJson(raw) : parseListingHtml(raw);
  }

  /**
   * One polite GET: checks robots.txt, keeps the crawl delay, sends If-None-Match when an ETag
   * is stored, and returns 304s to the caller. Other non-2xx statuses throw a classified error.
   */
  private async get(
    ctx: RunContext,
    url: string,
    opts: { conditional?: boolean; checkRobots?: boolean; allowMissing?: boolean } = {},
  ): Promise<HttpResponse> {
    const { conditional = true, checkRobots = true, allowMissing = false } = opts;
    const path = new URL(url).pathname;
    if (checkRobots && !isAllowed(this.robots ?? ALLOW_ALL, path)) {
      throw new CollectorError('bad_request', `robots.txt disallows ${path}`);
    }
    await this.keepCrawlDelay(ctx);
    const etag = conditional ? await ctx.etag(url) : undefined;
    const res = await ctx.http.request({
      url,
      headers: { accept: this.config.format === 'json' ? 'application/json' : 'text/html', ...(etag ? { 'if-none-match': etag } : {}) },
    });
    this.lastRequestAt = ctx.now();
    if (res.status === 304 || (allowMissing && res.status === 404)) return res;
    assertOk(res);
    return res;
  }

  private async keepCrawlDelay(ctx: RunContext): Promise<void> {
    const delayMs = (this.robots?.crawlDelaySeconds ?? 0) * 1000;
    // A small margin, so two requests never land in the same second on the server's clock.
    const wait = this.lastRequestAt + delayMs + (delayMs > 0 ? 50 : 0) - ctx.now();
    if (wait > 0) await ctx.sleep(wait, ctx.signal);
  }

  private listingUrl(page: number): string {
    const path = this.config.category ? `/agora/c/${this.config.category}` : '/agora/latest';
    return this.url(`${path}${this.ext}`, { page: String(page) });
  }

  private get ext(): string {
    return this.config.format === 'json' ? '.json' : '';
  }

  private url(path: string, query: Record<string, string> = {}): string {
    const u = new URL(path, this.deps.baseUrl);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  }
}

/** Topic ids and last-activity times from sitemap.xml: `<url><loc>…/agora/t/ID</loc><lastmod>…</lastmod></url>`. */
export function parseSitemap(raw: RawResponse): TopicStub[] {
  if (!raw.body.includes('<urlset')) throw new CollectorError('parse', `${raw.url}: not a sitemap`, raw.status, [raw]);
  const out: TopicStub[] = [];
  for (const m of raw.body.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)) {
    const id = /\/agora\/t\/([^/?#]+)$/.exec(m[1] ?? '')?.[1];
    if (id && m[2]) out.push({ id, lastPostedAt: m[2] });
  }
  return out;
}
