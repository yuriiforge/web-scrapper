# Chirp (paid, metered posts API)

**Strategy: `api`**, the paid search API, because there is no free route. Collector: [`packages/collectors/src/chirp`](../../packages/collectors/src/chirp).

## Options considered

| Option | Verdict | Why |
| --- | --- | --- |
| **Official API** | **Chosen** | The only route the platform allows; priced per post |
| Scraping the website | Rejected | Against the platform's terms, and the target of its strictest protection |
| Vendor dataset | Worth pricing at scale | Cheaper per post for large backfills; often too slow for fresh data |

## The rule: pay once per post

Every post Chirp returns costs one credit, and a search that finds nothing costs one credit too. So the collector's job is to never buy the same post twice and never buy more than the budget allows.

- **The checkpoint records what is still missing, as time windows:**
  - every post newer than the newest one stored;
  - plus any older gaps a run left when it stopped early.

  Chirp's `since` and `until` parameters ask for exactly those windows. Windows are collected newest first, and a run that stops records the unfinished part of the window it was in. That checkpoint is saved even when the run ends as `partial` (out of credits or budget), so a stored post is never bought twice.
- **Budget:**
  - Before every request, the collector asks for no more posts than the source's remaining monthly budget covers. Chirp's smallest page is 10 posts, so it stops as soon as fewer than 10 are affordable; it never overspends, it only underspends.
  - A 402 from Chirp (account out of credits) also ends the run as `partial`.
- **Caps:**
  - `maxPostsPerRun` (default 1,000) limits one run; the rest waits in the gaps for the next run.
  - `backfillDays` (default 30) limits how far back the first run goes; older posts are never bought.
- **Ledger:** every charge (`usage.credits_charged`) goes into the cost ledger immediately. The integration tests check that the ledger equals Chirp's own `credits_used`.

## Rate limit

30 requests a minute per key. The collector paces itself at 25 a minute, and when `x-rate-limit-remaining` reaches 0 it waits until `x-rate-limit-reset` (epoch seconds) rather than spending a request on a 429. A 429 isn't charged anyway, but it wastes time.

## Data notes

- About 40% of posts carry no country (`geo: null`). Their country stays `null`, not a guess.
- `author_id` is an opaque id, stored as the author.
- Likes, replies, reposts and language go into `items.meta`.

## What breaks it

| Change on the site | What happens |
| --- | --- |
| Layout version 2 (`public_metrics` moved, `geo.country_code` renamed) | `parse` error; the response is kept |
| Credits run out mid-run | `partial`; the checkpoint keeps the gap, and the next run continues there |
| Budget reached | `partial` before the request that would exceed it |
| Invalid key | `auth` |

## Known limit

Posts that share the exact second at the edge of a gap may be skipped. Chirp's `until` is exclusive and times are whole seconds. At these volumes that affects at most a post or two per gap.
