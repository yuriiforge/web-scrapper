# mock-web

One Docker service that imitates five kinds of external data source, so a scraping platform can be built and tested at zero cost. All data is fake and fixed by `SEED`, and you can make each site fail in specific ways on demand through `/_admin`.

| Mount path  | Imitates                     | Practises                                              |
| ----------- | ---------------------------- | ------------------------------------------------------ |
| `/threadit` | A social site's official API | OAuth tokens, cursor pagination, rate-limit headers    |
| `/agora`    | A public forum               | HTML parsing, finding JSON endpoints, conditional requests |
| `/ratewell` | A review site                | JavaScript rendering, Playwright, bot checks, blocks   |
| `/passgate` | A managed unblocker API      | Escalation to a paid tier, credit accounting           |
| `/chirp`    | A paid posts API             | Metered usage, quotas, budget caps                     |
| `/_admin`   | Control plane                | Fault injection, layout changes, new content, ground truth |

All brands, people and text are invented.

## Running

```sh
docker compose up --build          # http://localhost:4000
curl http://localhost:4000/_health # {"status":"ok","seed":42,"items":66564}
```

Without Docker (Node.js 20 or later):

```sh
npm install
npm run dev      # watch mode via tsx
npm test         # vitest + supertest
npm run build && npm start
```

The whole corpus (about 66,000 items) is built in memory at boot from `SEED`; nothing is stored on disk. `GET /` lists the sites.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4000` | Listen port |
| `SEED` | `42` | Seed for all generated data |
| `MOCK_NOW` | boot time | ISO timestamp used as "now" when dating items. Set it for runs that repeat exactly. |
| `THREADIT_CLIENT_ID` | `dev-id` | OAuth client id |
| `THREADIT_CLIENT_SECRET` | `dev-secret` | OAuth client secret |
| `THREADIT_TOKEN_TTL` | `300` | Access-token lifetime in seconds |
| `THREADIT_RATE` | `60` | Requests per rolling 60 s per token |
| `AGORA_RATE` | `10` | Requests per second per IP |
| `RATEWELL_RATE` | `30` | Data requests per 60 s per session before a 300 s block |
| `PASSGATE_KEY` | `pg-dev-key` | PassGate API key |
| `PASSGATE_CREDITS` | `2000` | PassGate starting balance |
| `CHIRP_KEY` | `chirp-dev-key` | Chirp API key |
| `CHIRP_CREDITS` | `10000` | Chirp starting balance |
| `CHIRP_RATE` | `30` | Requests per 60 s per key |
| `LOG_LEVEL` | `info` | pino level (`debug` logs every request; `silent` turns logging off) |

Invalid values stop the service at startup with a message naming the variable.

## One example per site

```sh
# Threadit: get a token, then read the newest posts in a community
TOKEN=$(curl -s -u dev-id:dev-secret -d grant_type=client_credentials \
  http://localhost:4000/threadit/api/v1/access_token | jq -r .access_token)
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:4000/threadit/c/gb/new?limit=5"

# Agora: plain HTML, then the conditional-request flow
curl -s -D - http://localhost:4000/agora/c/meal-kits -o /dev/null | grep -i etag
curl -s -o /dev/null -w "%{http_code}\n" -H 'If-None-Match: "<etag from above>"' http://localhost:4000/agora/c/meal-kits

# Ratewell: curl is detected as a bot (403, X-RW-Block: ua). Open it in a browser instead.
curl -s -D - -o /dev/null http://localhost:4000/ratewell/company/voltra-motors | grep -i x-rw-block

# PassGate: get the Ratewell page with reviews already rendered (5 credits)
curl -s -H "Authorization: Bearer pg-dev-key" \
  "http://localhost:4000/passgate/v1/fetch?url=/ratewell/company/voltra-motors&render=true"

# Chirp: search (1 credit per post returned)
curl -s -H "Authorization: Bearer chirp-dev-key" \
  "http://localhost:4000/chirp/v2/search?query=delivery&country=GB&max_results=20"
```

## Site notes

**Threadit.** `POST /threadit/api/v1/access_token` (Basic auth, `grant_type=client_credentials`), then `GET /threadit/c/:community/new`, `/threadit/c/:community/search?q=` and `/threadit/posts/:id/comments`, each with `limit` (1–100) and `after`. The communities are `gb`, `de`, `fr`, `us`, `pl` and `ua`, plus the topic communities `electric_cars`, `budget_airlines`, `meal_kits`, `fitness_trackers` and `online_banks`. Cursors are item ids, so publishing new posts never shifts a page.

**Agora.** `/agora/`, `/agora/c/:slug`, `/agora/t/:id` and `/agora/latest`, each with `?page=N`. Adding `.json` to the path returns the same data as JSON; the HTML never links to it. `/agora/robots.txt` and `/agora/sitemap.xml` are available. `/agora/admin/` returns 403, so a crawler that ignores robots.txt shows up in the request log.

**Ratewell.** A company page is an empty shell. `public/ratewell/app.js` computes `X-RW-Token = fnv1a32_hex("<nonce>:<rw_sid>")`, where the hash is 8 lowercase hex digits. It then fetches `/ratewell/_data/company/:slug/reviews?page=N` and renders the reviews. A nonce is valid for 10 minutes and only with the `rw_sid` it was issued to. Requests through PassGate skip the bot checks, the token check and the rate limit.

**PassGate.** `GET /passgate/v1/fetch?url=<path>&render=<bool>&page=<n>` and `GET /passgate/v1/usage`. The response passes through the target's status and content type and adds `X-PassGate-Credits-Charged`, `X-PassGate-Credits-Remaining` and `X-PassGate-Target-Status`. A target 5xx, or a target that cannot be reached (`502 {"error":"target_unreachable"}`), is not charged.

**Chirp.** `GET /chirp/v2/search` (`query`, `country`, `since`, `until`, `max_results` 10–100, `next_token`) and `GET /chirp/v2/usage`. `since` is inclusive and `until` exclusive. When the balance is lower than the page size, a partial page is returned.

## Admin and chaos

`/_admin` has no authentication and is never affected by chaos or rate limits.

| Endpoint | Purpose |
| --- | --- |
| `GET /_admin/state` | Chaos settings, credit balances and item counts |
| `PUT /_admin/chaos/:site` | Partial update; `:site` is a site name or `all` |
| `POST /_admin/publish` | `{"site","count","topic?"}` creates items dated now and returns their ids |
| `POST /_admin/credits` | `{"site":"passgate"\|"chirp","balance":N}` |
| `GET /_admin/truth?ids=a,b,c` | Ground truth for up to 500 ids |
| `GET /_admin/requests?site=&since=` | Counts by site and status, peak requests per second, last 200 entries |
| `POST /_admin/reset` | Regenerates the corpus and clears tokens, sessions, rate buckets, credits and chaos |

How to trigger each chaos setting:

```sh
A=http://localhost:4000/_admin
J='Content-Type: application/json'

# errorRate: share of requests answered with 500/502/503 {"error":"internal"}
curl -X PUT $A/chaos/threadit -H "$J" -d '{"errorRate":0.3}'

# timeoutRate: share of requests held for 30 s, after which the socket is destroyed
curl -X PUT $A/chaos/agora -H "$J" -d '{"timeoutRate":0.1}'

# latencyMs: added to every response
curl -X PUT $A/chaos/all -H "$J" -d '{"latencyMs":800}'

# emptyResults: listings return 200 with zero items and no next cursor or page
curl -X PUT $A/chaos/chirp -H "$J" -d '{"emptyResults":true}'

# layoutVersion: 2 switches to the changed layout, 1 restores it
curl -X PUT $A/chaos/all -H "$J" -d '{"layoutVersion":2}'

# botCheckLevel (Ratewell only): 0 off, 1 headers, 2 + webdriver, 3 everything not via PassGate
curl -X PUT $A/chaos/ratewell -H "$J" -d '{"botCheckLevel":3}'

# Back to defaults (this also regenerates data and refills credits)
curl -X POST $A/reset
```

Layout version 2 makes one breaking change per site:

- **Threadit:** `selftext` is renamed `body_text`.
- **Agora:** `.post-body` becomes `.post-content`, and JSON `cooked` becomes `html`.
- **Ratewell:** `reviews` becomes `items`, `rating` becomes a string such as `"4/5"`, and `.review-body` becomes `.rv-text`.
- **Chirp:** `public_metrics` moves to `metrics.public_metrics`, and `geo.country_code` becomes `geo.country`.

Other useful admin calls:

```sh
curl -X POST $A/publish -H "$J" -d '{"site":"threadit","count":10,"topic":"meal kits"}'
curl -X POST $A/credits -H "$J" -d '{"site":"chirp","balance":30}'
curl "$A/truth?ids=t3_000001,ap_000002,rv_000003,ch_0000004"
curl "$A/requests?site=agora&since=2026-10-07T00:00:00Z"
```

## Data and ground truth

The corpus covers five topics (electric cars, budget airlines, meal kits, fitness trackers, online banks), six categories (price, quality, customer service, reliability, usability, delivery) and six countries (GB, DE, FR, US, PL, UA). It has 1,500 authors.

Text comes from 270 sentence templates. The first sentence of an item sets its true category and sentiment, and about 10% of items mix in a second sentiment. About 2% of items are exact text copies of an item on another site by a different author, about 1% are empty, and about 1% contain emoji, literal HTML entities and non-Latin script.

The sites never return ground truth. Only `/_admin/truth` does.

| Prefix | Item |
| --- | --- |
| `t3_` / `t1_` | Threadit post / comment |
| `at_` / `ap_` | Agora topic / post |
| `rv_` | Ratewell review |
| `ch_` | Chirp post |

## Layout

```text
src/
  index.ts        boot and listen          app.ts       Express app factory (used by tests)
  config.ts       env validation (zod)     context.ts   corpus + state + clock per app
  state.ts        in-memory stores         admin.ts     /_admin routes
  seed/           corpus generation        middleware/  requestLog, chaos, rateLimit
  sites/          one router per site      lib/         rng, http and format helpers
public/ratewell/app.js                     Ratewell client script
test/                                      one file per site + determinism, seed, chaos, admin
```
