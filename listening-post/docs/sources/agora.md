# Agora (public forum)

**Strategy: `html`**, meaning public pages and no credentials. By default the collector reads the hidden `.json` endpoints; `format: "html"` parses the visible pages instead. Collector: [`packages/collectors/src/agora`](../../packages/collectors/src/agora).

## Options considered

| Option | Verdict | Why |
| --- | --- | --- |
| Official API | Not available | Agora publishes no API or keys |
| HTML pages | Kept, as the fallback | Works for anyone, but markup changes more often than data, and pages are bigger |
| Hidden JSON endpoints | **Chosen as default** | Same data, 20–30% fewer bytes (measured on topic and listing pages), typed fields instead of CSS selectors, and an ETag on every response |
| Headless browser | Rejected | Pages are server-rendered; a browser would add cost and nothing else |
| Unblocker (PassGate) | Rejected | Nothing blocks a polite client here |

## How the JSON endpoints were found

The HTML never links to them, so they had to be found by hand.

1. The page structure (`tr.topic-row`, `article.post[data-post-number]`) and URL shapes (`/c/:slug`, `/t/:id`) match a well-known open-source forum engine. That engine serves every page as JSON when `.json` is appended to the path.
2. Requesting `/agora/latest.json` and `/agora/t/<id>.json` returned JSON with the same topics and posts.
3. The integration tests (`agora.int.test.ts`) check that the two formats agree. They compare every post of the 30 most active topics, over 300 posts, and they must produce identical items.

In practice the same checks apply to any site: look for `.json` or `?format=json` variants, watch the browser's network tab for XHR calls, and read `<link rel="alternate">` tags.

## Politeness

- **robots.txt** is read at the start of every run. Disallowed paths are never requested: the collector refuses them before sending. `Crawl-delay: 1` is obeyed with evenly spaced requests (no bursts), plus a 50 ms margin.
- **Conditional requests.** Every listing and topic page is fetched with `If-None-Match` when an ETag is stored. A rerun with nothing new costs two 304s: robots.txt and the first listing page.
- ETags are saved only when a run succeeds. A failed run must never leave an ETag that would make the next run skip content that was never stored.

## Incremental runs

Listings are sorted by latest activity. The checkpoint stores a watermark: every topic last active at or before it is stored. The next run walks the listing, stops at the first topic that isn't newer, and fetches only topics with new posts (all their pages, since every page carries the post count).

**First crawl of every category:** the collector reads `sitemap.xml` instead. One request lists all 800 topics with their last activity, rather than walking about 27 listing pages. A single-category source walks its category listing, because the sitemap doesn't say which category a topic is in.

**`maxTopics` caps one run without losing anything.** A capped run doesn't move the watermark. It records the band of activity it covered (`done: {from, to}`), and the next run:

- fetches topics newer than the band (new activity);
- skips the band;
- continues with the backlog below it, until it reaches the watermark.

Once a run finishes without hitting the cap, the watermark moves to the newest activity and the band is cleared. While a backlog remains, the first listing page is not fetched conditionally, because a 304 there would end the run before the backlog.

## What breaks it

| Change on the site | What happens |
| --- | --- |
| Layout version 2 (`.post-body` becomes `.post-content`, `cooked` becomes `html`) | The run fails with a `parse` error naming the missing field; the response is kept for fixing the parser |
| 429 | Waits `Retry-After: 1` and retries |
| 5xx | Retries with backoff |
| Topic or page gone (404) | `bad_request`: the run fails |
