import type { AgoraConfig } from '@lp/shared';
import { CollectorError, assertOk } from '../errors';
import type { HttpResponse } from '../http';
import { ALLOW_ALL, isAllowed, parseRobots, type RobotsRules } from '../robots';
import type { Collector, CollectorDeps, FetchResult, ParsedItem, RawResponse, RunContext } from '../types';
import { parseListingHtml, parseListingJson, parseTopicHtml, parseTopicJson, type ListingPage, type TopicRef } from './parse';

const USER_AGENT_TOKEN = 'ListeningPost';
const ROBOTS_URL = /\/agora\/robots\.txt$/;
const LISTING_URL = /\/agora\/(c\/[a-z0-9-]+|latest)(\.json)?(\?|$)/;
const TOPIC_URL = /\/agora\/t\/([^/?.]+)(\.json)?(\?|$)/;

export interface AgoraState {
  listPage: number;
  topicsFetched: number;
}

export interface AgoraCheckpoint {
  /** last_posted_at of the most recently active topic seen; older activity is already stored. */
  watermark: string | null;
  /** Rules from the last robots.txt read, reused when it answers 304. */
  robots: RobotsRules | null;
}

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
  private newest: string | null = null;
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
    this.newest = this.since;
    this.robots = checkpoint?.robots ?? null;
    return { listPage: 1, topicsFetched: 0 };
  }

  checkpoint(): AgoraCheckpoint {
    return { watermark: this.newest, robots: this.robots };
  }

  async fetchPage(ctx: RunContext, state: AgoraState): Promise<FetchResult<AgoraState>> {
    const responses: RawResponse[] = [];
    if (state.listPage === 1) {
      const robots = await this.loadRobots(ctx);
      if (robots) responses.push(robots);
    }

    const listing = await this.get(ctx, this.listingUrl(state.listPage));
    if (listing.status === 304) {
      // Sorted by latest activity: an unchanged first page means nothing new anywhere.
      ctx.log.info({ page: state.listPage }, 'listing unchanged since last run');
      return { responses, next: null };
    }
    responses.push(listing);
    const page = this.parseListing(listing);

    for (const t of page.topics) if (!this.newest || t.lastPostedAt > this.newest) this.newest = t.lastPostedAt;
    const changed = page.topics.filter((t) => !this.since || t.lastPostedAt > this.since);
    const room = this.config.maxTopics === undefined ? changed.length : Math.max(0, this.config.maxTopics - state.topicsFetched);
    const toFetch = changed.slice(0, room);
    for (const topic of toFetch) responses.push(...(await this.fetchTopic(ctx, topic)));

    const topicsFetched = state.topicsFetched + toFetch.length;
    const reachedWatermark = changed.length < page.topics.length;
    const capped = this.config.maxTopics !== undefined && topicsFetched >= this.config.maxTopics;
    ctx.log.debug({ page: state.listPage, topics: page.topics.length, changed: changed.length, fetched: toFetch.length }, 'agora listing');
    const next = page.hasNext && !reachedWatermark && !capped ? { listPage: state.listPage + 1, topicsFetched } : null;
    return { responses, next };
  }

  parse(raw: RawResponse): ParsedItem[] {
    if (ROBOTS_URL.test(raw.url) || LISTING_URL.test(raw.url)) return [];
    const m = TOPIC_URL.exec(raw.url);
    if (!m) throw new CollectorError('parse', `no Agora parser for ${raw.url}`);
    const topic = m[2] ? parseTopicJson(raw) : parseTopicHtml(raw);
    return topic.posts.map((p) => ({
      externalId: p.id,
      author: p.username,
      // The opening post carries the topic title, as on Threadit.
      text: p.postNumber === 1 ? `${topic.title}\n\n${p.html}` : p.html,
      country: null,
      publishedAt: new Date(p.createdAt),
    }));
  }

  private async fetchTopic(ctx: RunContext, topic: TopicRef): Promise<RawResponse[]> {
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
