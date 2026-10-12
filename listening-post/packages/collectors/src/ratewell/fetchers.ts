import type { Browser, Page, Response as PwResponse } from 'playwright';
import { CollectorError, assertOk } from '../errors';
import type { HttpResponse } from '../http';
import type { RawResponse, RunContext } from '../types';
import { BROWSER_ACCEPT_LANGUAGE, BROWSER_USER_AGENT, blockedError, cookieFrom, extractNonce, fnv1aHex } from './session';

/** One way of getting review page `n` of a company. Throws CollectorError('blocked') when a bot check stops it. */
export interface ReviewFetcher {
  page(ctx: RunContext, n: number): Promise<RawResponse>;
  close?(ctx: RunContext): Promise<void>;
}

const dataPath = (company: string, n: number) => `/ratewell/_data/company/${company}/reviews?page=${n}`;

/**
 * Step 1, plain HTTP: load the company page for the session cookie and nonce, then call the
 * data endpoint with the token app.js would compute. Free, fast, and enough until the site
 * insists on its own browser checks or forces everything through PassGate.
 */
export class PlainFetcher implements ReviewFetcher {
  private session: { cookie: string; nonce: string } | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly company: string,
  ) {}

  async page(ctx: RunContext, n: number): Promise<RawResponse> {
    for (let attempt = 0; ; attempt++) {
      const s = this.session ?? (await this.start(ctx));
      const url = new URL(dataPath(this.company, n), this.baseUrl).toString();
      const res = await ctx.http.request({
        url,
        headers: {
          ...browserHeaders('application/json'),
          cookie: `rw_sid=${s.cookie}`,
          referer: new URL(`/ratewell/company/${this.company}`, this.baseUrl).toString(),
          'x-rw-nonce': s.nonce,
          'x-rw-token': fnv1aHex(`${s.nonce}:${s.cookie}`),
        },
      });
      const blocked = blockedError(res);
      if (blocked) throw blocked;
      // A nonce lives 10 minutes; a long run gets a fresh one once.
      if (res.status === 403 && attempt === 0) {
        ctx.log.info('token rejected, starting a new session');
        this.session = undefined;
        continue;
      }
      assertOk(res);
      return res;
    }
  }

  private async start(ctx: RunContext): Promise<{ cookie: string; nonce: string }> {
    const url = new URL(`/ratewell/company/${this.company}`, this.baseUrl).toString();
    const res = await ctx.http.request({ url, headers: browserHeaders('text/html') });
    const blocked = blockedError(res);
    if (blocked) throw blocked;
    assertOk(res);
    const cookie = cookieFrom(res.headers['set-cookie'], 'rw_sid');
    const nonce = extractNonce(res.body);
    if (!cookie || !nonce) throw new CollectorError('parse', `${url}: no rw_sid cookie or nonce; the page changed`, res.status, [res]);
    this.session = { cookie, nonce };
    return this.session;
  }
}

/**
 * Step 2, a real browser (Playwright, Chromium): the page runs its own script and fetches the
 * reviews; the collector captures those JSON responses and clicks "Load more" for the next page.
 * It looks like a person's Chrome: normal user agent and language, and navigator.webdriver hidden
 * (Ratewell flags sessions that report it).
 */
export class BrowserFetcher implements ReviewFetcher {
  private browser: Browser | undefined;
  private page_: Page | undefined;
  private openedAt = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly company: string,
    private readonly opts: { headless: boolean; minuteUsd: number; hideWebdriver?: boolean },
  ) {}

  async page(ctx: RunContext, n: number): Promise<RawResponse> {
    const isData = (r: PwResponse) => r.url().includes(dataPath(this.company, n));
    if (!this.page_) {
      // Page 1 is fetched by the page's own script as it loads; later pages need a click.
      const page = await this.open(ctx);
      const url = new URL(`/ratewell/company/${this.company}`, this.baseUrl).toString();
      await ctx.http.throttle(url);
      const data = page.waitForResponse(isData, { timeout: 30_000 }).catch(() => null);
      const nav = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (nav) {
        const blocked = blockedError({ url, status: nav.status(), headers: nav.headers() });
        if (blocked) throw blocked;
      }
      // app.js requested page 1 on load; for n > 1 (a resumed escalation) click through to n.
      let response = await data;
      for (let p = 2; p <= n; p++) response = await this.click(ctx, page, p);
      return this.capture(response, url);
    }
    return this.capture(await this.click(ctx, this.page_, n), dataPath(this.company, n));
  }

  async close(ctx: RunContext): Promise<void> {
    if (!this.browser) return;
    await this.browser.close();
    this.browser = undefined;
    const minutes = (ctx.now() - this.openedAt) / 60_000;
    await ctx.charge({ provider: 'browser', units: round(minutes, 4), unit: 'browser-minute', usd: round(minutes * this.opts.minuteUsd, 6) });
  }

  private async open(ctx: RunContext): Promise<Page> {
    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({ headless: this.opts.headless });
    this.openedAt = ctx.now();
    const context = await this.browser.newContext({
      userAgent: BROWSER_USER_AGENT,
      locale: 'en-GB',
      extraHTTPHeaders: { 'accept-language': BROWSER_ACCEPT_LANGUAGE },
      viewport: { width: 1366, height: 900 },
    });
    // Automation reports navigator.webdriver = true; a person's browser does not.
    if (this.opts.hideWebdriver !== false) {
      await context.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
      });
    }
    this.page_ = await context.newPage();
    ctx.signal.addEventListener('abort', () => void this.browser?.close().catch(() => undefined), { once: true });
    return this.page_;
  }

  private async click(ctx: RunContext, page: Page, n: number): Promise<PwResponse | null> {
    await ctx.http.throttle(new URL(dataPath(this.company, n), this.baseUrl).toString());
    const button = page.locator('#load-more');
    if ((await button.count()) === 0) throw new CollectorError('parse', `no #load-more button for page ${n}`);
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(dataPath(this.company, n)), { timeout: 30_000 }),
      button.click(),
    ]);
    return response;
  }

  private async capture(response: PwResponse | null, url: string): Promise<RawResponse> {
    if (!response) throw new CollectorError('transient', `${url}: the page did not request its reviews within 30 s`);
    const raw: HttpResponse = {
      url: response.url(),
      status: response.status(),
      headers: response.headers(),
      body: await response.text(),
      fetchedAt: new Date(),
    };
    const blocked = blockedError(raw);
    if (blocked) throw blocked;
    assertOk(raw);
    return raw;
  }
}

/**
 * Step 3, the PassGate unblocker: it fetches the page on our behalf and always gets through, for
 * credits. The raw data JSON costs 1 credit a page; a rendered page costs 5 and is used only if the
 * raw route fails. Every charge goes to the cost ledger, and the source's budget is checked first.
 */
export class PassGateFetcher implements ReviewFetcher {
  constructor(
    private readonly company: string,
    private readonly pg: { baseUrl: string; key: string; creditUsd: number },
  ) {}

  async page(ctx: RunContext, n: number): Promise<RawResponse> {
    try {
      return await this.fetch(ctx, { url: dataPath(this.company, n) }, 1);
    } catch (err) {
      if (!(err instanceof CollectorError) || !['parse', 'blocked'].includes(err.errorClass)) throw err;
      ctx.log.warn({ page: n, reason: err.message }, 'raw fetch via PassGate failed, trying a rendered page');
      return this.fetch(ctx, { url: `/ratewell/company/${this.company}`, render: 'true', page: String(n) }, 5);
    }
  }

  private async fetch(ctx: RunContext, query: Record<string, string>, credits: number): Promise<RawResponse> {
    const left = await ctx.budgetLeftUsd();
    if (left !== null && left < credits * this.pg.creditUsd) {
      throw new CollectorError('quota', `monthly budget for this source is used up ($${left.toFixed(4)} left)`);
    }
    const url = new URL('/passgate/v1/fetch', this.pg.baseUrl);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await ctx.http.request({ url: url.toString(), headers: { authorization: `Bearer ${this.pg.key}` } });

    const charged = Number(res.headers['x-passgate-credits-charged'] ?? 0);
    if (charged > 0) {
      await ctx.charge({ provider: 'passgate', units: charged, unit: 'credit', usd: round(charged * this.pg.creditUsd, 6) });
    }
    if (res.status === 402) throw new CollectorError('quota', 'PassGate credits are used up', 402);
    if (res.status === 401) throw new CollectorError('auth', 'PassGate rejected the API key', 401);
    const blocked = blockedError(res);
    if (blocked) throw blocked;
    assertOk(res);
    return res;
  }
}

function browserHeaders(accept: string): Record<string, string> {
  return { 'user-agent': BROWSER_USER_AGENT, 'accept-language': BROWSER_ACCEPT_LANGUAGE, accept };
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
