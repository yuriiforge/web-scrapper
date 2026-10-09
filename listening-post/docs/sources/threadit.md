# Threadit (social site with an official API)

**Strategy: `api`**, the official OAuth API. Collector: [`packages/collectors/src/threadit`](../../packages/collectors/src/threadit).

## Options considered

| Option | Verdict | Why |
| --- | --- | --- |
| **Official API** | **Chosen** | Stable JSON, cursor paging, published rate limits, free at this volume |
| HTML scraping | Rejected | Slower and breaks with every redesign; it also ignores a rate limit the site states openly |
| Unblocker | Rejected | Nothing to unblock; it would only add cost |
| Vendor dataset | Not needed | The API covers the data and is current |

## How it works

- **Auth:** client-credentials token, cached and refreshed before it expires: 30 s early, or halfway through very short lifetimes. A 401 refreshes once; a second 401 fails the run as `auth`.
- **Paging:** `after` cursor, newest first. The run stops at the checkpoint (the newest post stored), so later runs read one page when nothing is new.
- **Rate limit:** 50 requests a minute by default, under the published 60, enforced by the shared token bucket. The collector also reads `X-Ratelimit-Remaining`/`X-Ratelimit-Reset` and waits for the window to reset instead of spending a request on a 429.
- **Comments:** fetched for each new post with comments, as part of the same page.
- **Country:** set from the community when it is a country (`gb`, `de`, …); `null` for topic communities and for comments.

## What breaks it

| Change on the site | What happens |
| --- | --- |
| Layout version 2 (`selftext` renamed `body_text`) | The run fails with a `parse` error; the response is kept |
| Token lifetime shortened | Refreshed early; tested with a 2 s lifetime |
| Rate limit lowered | Header-driven waits; tested at 10 a minute with zero 429s |
| 5xx | Retries with backoff; tested with 30% errors |
| Community removed (404) | `bad_request`: the run fails without retrying |
