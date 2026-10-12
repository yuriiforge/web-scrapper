# Listening Post

A scraping platform pet project. It collects posts and reviews from the five fake sites in [`../mock-web`](../mock-web), stores them in PostgreSQL, scores sentiment by country and category, and shows everything in a Next.js dashboard.

Status: **steps 1–8 are done**. That covers:

- the collector framework;
- Threadit (official API);
- Agora (forum: HTML, hidden JSON, robots.txt, ETags);
- Ratewell (bot-protected reviews: plain HTTP → Playwright → PassGate unblocker, with costs and budgets);
- Chirp (paid, metered API: pays once per post, stays within budget, never buys a post twice);
- monitoring: alerts that open and close themselves, a webhook, and re-parse after a parser fix;
- analysis: a free rules scorer for every item, an optional Claude scorer, cross-site duplicates, and accuracy checked against mock-web's ground truth;
- a NestJS API, and a dashboard with sources, runs, items, costs and insights.

Each source has a short write-up of why it uses its strategy in [`docs/sources/`](docs/sources); scoring is described in [`docs/analysis.md`](docs/analysis.md).

## Run it

```sh
docker compose up --build -d
```

| URL | What |
| --- | --- |
| http://localhost:3000 | Dashboard, described below |
| http://localhost:3001/health | API health: database and worker heartbeat |
| http://localhost:3001/api/... | REST API, see below |
| http://localhost:4000 | mock-web, the sites being scraped |
| `localhost:5432` | Postgres, user `lp`, password `lp`, database `listening_post` |

The first start adds two demo clients with eight sources, so data arrives without doing anything:

- four on Threadit;
- two on Agora (one reading JSON, one parsing HTML);
- two on Ratewell, one with a $1 monthly budget;
- two on Chirp, with $2 and $1 monthly budgets.

Nine of them have cron schedules.

To watch Ratewell's escalation ladder, raise the bot checks on mock-web, then press **Run now** on a Ratewell source:

```sh
curl -X PUT localhost:4000/_admin/chaos/ratewell -H 'content-type: application/json' -d '{"botCheckLevel":3}'
```

The run ends "via unblocker", and the Costs page shows the browser time and PassGate credits it used. Set the level back to 1 afterwards.

First crawls are slow on purpose. A Threadit community with comments takes about 10 minutes, because the collector stays under Threadit's limit of 60 requests a minute. An Agora category takes about 5 minutes, because robots.txt asks for one request a second. Later runs read only what is new and finish in seconds. On Agora, a rerun with nothing new costs two 304 responses.

`docker compose down -v` stops everything and deletes the database.

## Access

- **Dashboard:** sign in with the admin password (`ADMIN_PASSWORD`, default `admin` in Docker). The session is a signed, HttpOnly cookie valid for 12 hours.
- **API:** every `/api` request needs `Authorization: Bearer $API_TOKEN` (default `dev-api-token-change-me` in Docker). Only the dashboard's server holds the token; browsers never call the API directly. `/health` stays open for container healthchecks.

For anything beyond local use, set `ADMIN_PASSWORD`, `SESSION_SECRET` and `API_TOKEN` in a `.env` file next to `docker-compose.yml`. Leaving `ADMIN_PASSWORD` or `API_TOKEN` empty turns that check off, which is meant only for local development without Docker.

```sh
curl -s localhost:3001/api/sources -H "Authorization: Bearer dev-api-token-change-me"
```

## Dashboard

| Page | What it shows |
| --- | --- |
| **Overview** | Items collected, runs in the last 24 h, sources failing, spend this month, system health, sources needing attention, recent runs |
| **Sources** | Every source with client, schedule, item count and last run; **Add source**; per source: config, checkpoint, last 20 runs, Run now, Edit, Enable/Disable, Delete |
| **Runs** | Run history (live while active, with Cancel); per run: duration, pages, requests, new/seen items, the error, and the raw responses it stored |
| **Items** | Everything collected, newest first; search text, filter by site, source and country; cursor paging |
| **Costs** | Per client and per source: runs, requests, new items, spend, cost per new item, budget; per provider once paid providers exist |
| **Insights** | Conversations per day by site (7/30/90 days), items by country, items by source, the country × category sentiment grid, and scoring: coverage, copies, model spend, and each scorer's accuracy and per-class F1 with an **Evaluate** button |

Threadit, Agora and Ratewell over plain HTTP cost nothing per request. Spend comes from Ratewell's browser time ($0.01 a minute) and PassGate credits ($0.002 each), and from Chirp in step 5. Prices are set in the worker's environment (`BROWSER_MINUTE_USD`, `PASSGATE_CREDIT_USD`).

Charts use a fixed colour per site, validated for colour blindness in light and dark mode, with hover tooltips and a "Show as table" view. mock-web dates its data up to its fixed `MOCK_NOW` (7 Oct 2026), so days after that are empty in the charts.

## Monitoring

A monitor pass runs every minute in the worker, as a job on an exclusive queue, so only one runs at a time whatever the number of workers. Each condition below opens an alert while it holds and resolves it when it stops. Open alerts show on the Overview and on the source's page.

| Alert | Opens when | mock-web setting that triggers it |
| --- | --- | --- |
| `run_failed` | The last run failed | `errorRate: 1` |
| `layout_changed` | The last run failed because the parser didn't recognise a response | `layoutVersion: 2` |
| `zero_items` | A listing came back empty, though earlier ones had entries (not Chirp, where empty windows are normal) | `emptyResults: true` |
| `volume_drop` | Listings showed under 30% of the usual number of entries | `emptyResults`, partial blocks |
| `field_coverage` | The share of items with a country fell by over 20 points against the past week | — |
| `escalated` | Ratewell needed a costlier step than the source's first | `botCheckLevel: 3` |
| `quota` | The last run stopped early, out of credits or budget | `POST /_admin/credits` with a low balance |
| `budget` | This month's spend passed 80% of the source's budget | — |
| `stale` | No successful run for twice the schedule interval | `timeoutRate: 1`, worker stopped |
| `host_down` | The sources' host doesn't answer (not tied to one source) | mock-web stopped |

Set `ALERT_WEBHOOK_URL` on the worker, and every alert opened or resolved is POSTed there as `{ "event": "opened" | "resolved", "alert": { … } }`.

**Re-parse.** When a layout changes, the run fails, and the response that broke it is kept. After fixing the parser, **Re-parse** on the source's page (or `POST /api/sources/:id/reparse`) runs it over every stored raw response from the last 30 days and upserts the items, with no new requests.

## Analysis

An analysis pass runs every minute in the worker (an exclusive queue, like the monitor):

1. **Copies.** Items with the same normalised text (40 characters or more) point at the first one collected, across sites (`items.duplicate_of`).
2. **Rules.** A keyword scorer labels every item with a category and a sentiment. It is free and instant.
3. **Claude.** With `ANTHROPIC_API_KEY` set on the worker, originals without a model label go to Claude (`LLM_MODEL`, default `claude-opus-5-5`), newest first, 25 per request, up to 100 per pass. Answers are JSON validated against a Zod schema. Spend is booked per client under the `anthropic` provider and stops at `LLM_MONTHLY_USD` (default $5).
4. **Copies** take their original's labels, so a repost never costs a model call.

The sentiment grid uses Claude's label where there is one and the rules label otherwise, and counts each text once. **Evaluate** (or `POST /api/analysis/evaluations`) compares a random sample with mock-web's `/_admin/truth` and stores accuracy and per-class F1. On the current data the rules scorer reaches about 96% on category and 98% on sentiment. Its word lists were tuned on this corpus, though, so that score is optimistic. Details are in [`docs/analysis.md`](docs/analysis.md).

## How a run works

1. A run starts in one of two ways. "Run now" (`POST /api/sources/:id/runs`) creates a `queued` run row and puts a job on the `collect` queue in pg-boss. A source's cron schedule puts a job there directly.
2. The worker takes the job. The queue allows one active job per source, so runs of one source never overlap.
3. The executor (`packages/collectors/src/run.ts`) asks the site's collector for one page at a time. Each response is:
   1. stored gzipped in `raw_responses` (the body is skipped if it hasn't changed since the last fetch of that URL);
   2. parsed and validated with Zod;
   3. normalised and upserted into `items` on `(site, external_id)`, which counts new items exactly.
4. When the run succeeds, the checkpoint moves to the newest item, so the next run stops there. A failed run leaves the checkpoint alone and is simply repeated next time.

What happens on failure depends on the error class (`packages/collectors/src/errors.ts`):

| Class | Example | Handling |
| --- | --- | --- |
| `transient` | 500/502/503, timeout, network error | Retried per request: 5 times, exponential backoff with ±30% jitter |
| `rate_limited` | 429 | Waits `Retry-After`; doesn't count as a failure |
| `auth` | 401 | Refreshes the token once, then fails |
| `parse` | Layout changed, invalid JSON, missing CSS marker | Fails the run and keeps the response that broke it |
| `bad_request` | Unknown community, invalid config | Fails without retrying |
| `quota` | 402 | Ends the run as `partial` (used from step 5) |

Rate limits are a token bucket per site and target host, stored in Postgres (`rate_buckets`), so the limit holds across restarts and across several workers. Threadit's collector also reads `X-Ratelimit-Remaining` and waits for the reset instead of spending a request on a 429. Cancelling a run takes effect within 2 seconds, even mid-page; what was already saved stays.

## API

| Method and path | Purpose |
| --- | --- |
| `GET /api/clients` · `POST /api/clients` | List, create |
| `GET /api/sources?clientId=` · `POST /api/sources` | List (with last run and item count), create |
| `GET/PATCH/DELETE /api/sources/:id` | Read (with checkpoint), update, delete |
| `POST /api/sources/:id/runs` | Run now (202) |
| `GET /api/runs?sourceId=&status=&limit=` | Run history, newest first |
| `GET /api/runs/:id` · `POST /api/runs/:id/cancel` | Run detail, cancel |
| `GET /api/runs/:id/raw` | Raw responses a run stored (no bodies) |
| `POST /api/sources/:id/reparse` | Re-parse the source's stored raw responses (202), with no new requests |
| `GET /api/alerts?open=&sourceId=` | Open alerts (`open=false` for resolved ones), newest first |
| `GET /api/overview` | Everything the overview page shows |
| `GET /api/items?site=&sourceId=&country=&q=&cursor=&limit=` · `GET /api/items/:id` | Items, newest first with keyset paging (`country=none` for items without one); one item with its scores and raw response |
| `GET /api/costs?days=` | Spend and usage per client, source and provider |
| `GET /api/insights/volume` · `/countries` · `/sources` · `/sentiment` (all `?days=`) | Report data for the Insights page |
| `GET /api/analysis` | Scoring coverage per method, copies (and how many cross sites), model spend this month |
| `GET /api/analysis/evaluations` · `POST /api/analysis/evaluations` | Past evaluations, newest first; run one: `{ "method": "rules" | "llm", "sampleSize"?: 20–2000 }` (422 when that method has no labels yet, 502 when the truth endpoint is down) |

Errors are always `{ "error": "<code>", "field"?: "...", "message"?: "..." }`.

```sh
AUTH="Authorization: Bearer dev-api-token-change-me"
curl -s localhost:3001/api/sources -H "$AUTH" | jq '.[] | {name, itemCount, last: .lastRun.status}'
curl -s -X POST localhost:3001/api/sources/<id>/runs -H "$AUTH"
curl -s -X POST localhost:3001/api/sources -H "$AUTH" -H 'content-type: application/json' -d '{
  "clientId": "<client id>", "name": "Threadit · fr", "site": "threadit",
  "schedule": "*/20 * * * *", "config": { "community": "fr", "includeComments": false }
}'
```

Source config by site:

- **Threadit:** `community` (required), `pageSize` (1–100, default 100), `includeComments` (default true), `maxPages`, `ratePerMinute` (default 50).
- **Agora:** `category` (a slug such as `meal-kits`; unset means every category), `format` (`json` default, or `html`), `maxTopics`, `ratePerMinute` (at most 60; robots.txt Crawl-delay always applies).
- **Ratewell:** `company` (required, a slug such as `voltra-motors`), `strategies` (allowed ladder steps, default `["html","browser","unblocker"]`; leave out `unblocker` to never pay), `maxPages`, `ratePerMinute` (default 20). Set `budgetUsdMonth` on the source to cap spend.
- **Chirp:** `query` (required), `country`, `maxResults` (10–100, default 100), `maxPostsPerRun` (default 1,000), `backfillDays` (default 30), `ratePerMinute` (default 25). Set `budgetUsdMonth` to cap spend.

## Develop without Docker

```sh
npm install
cp .env.example .env
docker compose up -d postgres mock-web   # just the dependencies
npm run db:migrate && npm run db:seed
npm run dev:api      # http://localhost:3001 (tsup watch: NestJS needs SWC's decorator metadata)
npm run dev:worker
npm run dev:web      # http://localhost:3000
```

## Tests

```sh
npm test                    # unit tests: no database or network
npm run test:integration    # needs `docker compose up -d postgres` and ../mock-web with its dependencies installed
npm run typecheck
npm run lint -w @lp/web
```

The integration tests use a separate `listening_post_test` database, which they drop and recreate. They also start mock-web in-process, so each test can set its own limits and chaos. They take about 2 minutes, and include the acceptance checks for each build step:

| Step | Checks |
| --- | --- |
| 2 · Threadit | A full run stores every post and comment exactly once; a second run adds nothing; 10 requests a minute finishes with zero 429s; a 2-second token lifetime is refreshed during the run |
| 3 · Agora | HTML and JSON parsers produce identical items (over 300 posts compared); a rerun with nothing new gets mostly 304s; at most 1 request a second and no hits on `/agora/admin/` |
| 4 · Ratewell | The browser gets all 150 reviews at bot-check levels 1 and 2 (and is blocked when `navigator.webdriver` is left visible); level 3 escalates html → browser → unblocker and still completes; ledger credits equal PassGate's own count; out of credits or over budget ends as `partial` |
| 5 · Chirp | Collects every matching post with the ledger equal to Chirp's own count; a quiet rerun costs at most 1 credit; a balance of 30 stores 30 and ends `partial`, and after a top-up the next run buys only posts it doesn't have; a $0.01 budget stops at exactly 20 posts |
| 6 · Monitoring | Each mock-web failure (errors, empty results, layout change, bot level 3, credits, budget, stale schedule, host down) opens its alert, which closes once the failure stops, with both changes sent to the webhook; quiet reruns raise nothing; re-parse recovers data after a parser fix with zero new requests |
| 7 · Analysis | Cross-site copies are marked (short repeated replies are not) and re-pointed when the original is deleted; every item gets a rules label; only originals go to the model, and copies take their labels; unanswered items are not sent again; the ledger books $0.008 for 1,200 tokens without a source; the monthly cap and API errors stop the pass; rules labels score over 85% against mock-web's real ground truth |
| API | Validation per site, CRUD, run and cancel, cursor paging without repeats, filters (with a literal `%`), costs, insights, the sentiment grid, and evaluations against a stand-in truth endpoint |

They also cover retries under 30% server errors, layout-change detection in each format, an unknown community, incremental runs after new posts, prompt cancellation, and a retried job being a no-op. The Threadit rate-limit test waits about a minute by design.

## Layout

```text
apps/
  api/          NestJS 12: health, clients, sources, runs, reports, alerts, analysis (bundled with tsup + SWC)
  worker/       pg-boss consumer, schedule sync, monitor, analysis pass, stale-run sweep, raw retention, heartbeat
  web/          Next.js 16 dashboard (standalone output)
packages/
  shared/       domain constants, Zod env and API schemas, per-site source config
  db/           Drizzle schema, migrations (drizzle/), client, migrate and seed CLIs
  queue/        pg-boss setup, queue names and job types
  collectors/   framework (HTTP client, limiter, executor, errors) + one folder per site
  analysis/     rules and Claude scorers, duplicates, the analysis pass, evaluation
Dockerfile      one file, targets api | worker | web (Node 22)
```

Workspace packages are plain TypeScript source (`"exports": "./src/index.ts"`). tsup bundles them into each app's `dist/`; npm dependencies are never bundled (`tsup.preset.ts`). The API compiles through SWC because NestJS needs decorator metadata, which esbuild doesn't emit. Vitest uses SWC for the same reason.

## Changing the database

1. Edit `packages/db/src/schema.ts`.
2. `npm run db:generate` writes a new SQL file to `packages/db/drizzle/`. Read it before committing.
3. `npm run db:migrate` applies it locally. In Docker, the `migrate` service applies it on the next `up`.

## Notes

- After creating a new workspace's `package.json`, run `npm install` once before `npm i <pkg> -w <name>`. Otherwise npm silently skips the install.
- pg-boss 12 needs Node 22.12 or newer, so the images use Node 22 (mock-web stays on 20).
- `npm audit` reports moderate advisories in esbuild's dev server, which comes in through drizzle-kit and tsup. This project never starts that server.
- Next.js 16 ships its docs in `node_modules/next/dist/docs/`; see `apps/web/AGENTS.md`.
