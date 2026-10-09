# Listening Post

A scraping platform pet project. It collects posts and reviews from the five fake sites in [`../mock-web`](../mock-web), stores them in PostgreSQL, scores sentiment by country and category, and shows everything in a Next.js dashboard.

Status: **steps 1–3 and the step 8 dashboard are done**. That covers the collector framework, Threadit (official API), Agora (forum: HTML, hidden JSON, robots.txt, ETags), a NestJS API, and a dashboard with sources, runs, items, costs and insights. Still to come: Ratewell and Chirp (steps 4–5), monitoring and alerts (step 6), and sentiment scoring (step 7). Until step 7, the sentiment grid on Insights is empty. Each source has a short write-up of why it uses its strategy in [`docs/sources/`](docs/sources).

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

The first start adds two demo clients with six sources: four on Threadit and two on Agora (one reading JSON, one parsing HTML). Five have cron schedules, so data arrives without doing anything.

First crawls are slow on purpose. A Threadit community with comments takes about 10 minutes, because the collector stays under Threadit's limit of 60 requests a minute. An Agora category takes about 5 minutes, because robots.txt asks for one request a second. Later runs read only what is new and finish in seconds. On Agora, a rerun with nothing new costs two 304 responses.

`docker compose down -v` stops everything and deletes the database.

## Dashboard

| Page | What it shows |
| --- | --- |
| **Overview** | Items collected, runs in the last 24 h, sources failing, spend this month, system health, sources needing attention, recent runs |
| **Sources** | Every source with client, schedule, item count and last run; **Add source**; per source: config, checkpoint, last 20 runs, Run now, Edit, Enable/Disable, Delete |
| **Runs** | Run history (live while active, with Cancel); per run: duration, pages, requests, new/seen items, the error, and the raw responses it stored |
| **Items** | Everything collected, newest first; search text, filter by site, source and country; cursor paging |
| **Costs** | Per client and per source: runs, requests, new items, spend, cost per new item, budget; per provider once paid providers exist |
| **Insights** | Conversations per day by site (7/30/90 days), items by country, items by source, and the country × category sentiment grid |

Spend is $0 for now: Threadit and Agora are free to collect. Paid rows start with PassGate (step 4) and Chirp (step 5).

Charts use a fixed colour per site, validated for colour blindness in light and dark mode, with hover tooltips and a "Show as table" view. mock-web dates its data up to its fixed `MOCK_NOW` (7 Oct 2026), so days after that are empty in the charts.

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
| `GET /api/overview` | Everything the overview page shows |
| `GET /api/items?site=&sourceId=&country=&q=&cursor=&limit=` · `GET /api/items/:id` | Items, newest first with keyset paging (`country=none` for items without one); one item with its scores and raw response |
| `GET /api/costs?days=` | Spend and usage per client, source and provider |
| `GET /api/insights/volume` · `/countries` · `/sources` · `/sentiment` (all `?days=`) | Report data for the Insights page |

Errors are always `{ "error": "<code>", "field"?: "...", "message"?: "..." }`.

```sh
curl -s localhost:3001/api/sources | jq '.[] | {name, itemCount, last: .lastRun.status}'
curl -s -X POST localhost:3001/api/sources/<id>/runs
curl -s -X POST localhost:3001/api/sources -H 'content-type: application/json' -d '{
  "clientId": "<client id>", "name": "Threadit · fr", "site": "threadit",
  "schedule": "*/20 * * * *", "config": { "community": "fr", "includeComments": false }
}'
```

Source config by site:

- **Threadit:** `community` (required), `pageSize` (1–100, default 100), `includeComments` (default true), `maxPages`, `ratePerMinute` (default 50).
- **Agora:** `category` (a slug such as `meal-kits`; unset means every category), `format` (`json` default, or `html`), `maxTopics`, `ratePerMinute` (at most 60; robots.txt Crawl-delay always applies).

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
npm test                    # unit tests: no database or network (24 tests)
npm run test:integration    # needs `docker compose up -d postgres` and ../mock-web with its dependencies installed
npm run typecheck
npm run lint -w @lp/web
```

The integration tests use a separate `listening_post_test` database, which they drop and recreate. They also start mock-web in-process, so each test can set its own limits and chaos. They take about 2 minutes, and include the acceptance checks for each build step:

| Step | Checks |
| --- | --- |
| 2 · Threadit | A full run stores every post and comment exactly once; a second run adds nothing; 10 requests a minute finishes with zero 429s; a 2-second token lifetime is refreshed during the run |
| 3 · Agora | HTML and JSON parsers produce identical items (over 300 posts compared); a rerun with nothing new gets mostly 304s; at most 1 request a second and no hits on `/agora/admin/` |
| API | Validation per site, CRUD, run and cancel, cursor paging without repeats, filters (with a literal `%`), costs, insights and the sentiment grid |

They also cover retries under 30% server errors, layout-change detection in each format, an unknown community, incremental runs after new posts, prompt cancellation, and a retried job being a no-op. The Threadit rate-limit test waits about a minute by design.

## Layout

```text
apps/
  api/          NestJS 12: health, clients, sources, runs (bundled with tsup + SWC)
  worker/       pg-boss consumer, schedule sync, stale-run sweep, raw retention, heartbeat
  web/          Next.js 16 dashboard (standalone output)
packages/
  shared/       domain constants, Zod env and API schemas, per-site source config
  db/           Drizzle schema, migrations (drizzle/), client, migrate and seed CLIs
  queue/        pg-boss setup, queue names and job types
  collectors/   framework (HTTP client, limiter, executor, errors) + one folder per site
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
