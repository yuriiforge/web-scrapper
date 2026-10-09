# Listening Post

A scraping platform pet project. It collects posts and reviews from the five fake sites in [`../mock-web`](../mock-web), stores them in PostgreSQL, scores sentiment by country and category, and shows everything in a Next.js dashboard.

Status: **build step 1 of 8** (skeleton). Postgres, mock-web, a migration job, the API, the worker and the web app all run and report health. Collectors start in step 2.

## Run it

```sh
docker compose up --build -d
```

| URL | What |
| --- | --- |
| http://localhost:3000 | Dashboard (system status for now) |
| http://localhost:3001/health | API health: database and worker heartbeat |
| http://localhost:4000 | mock-web, the sites being scraped |
| `localhost:5432` | Postgres, user `lp`, password `lp`, database `listening_post` |

`docker compose down -v` stops everything and deletes the database. The next `up` recreates it from the migrations.

`/health` returns `ok`, `degraded` (database fine, no worker heartbeat in 30 s) or `down` (database unreachable, HTTP 503). Only `down` fails the API container's healthcheck, so a stopped worker never takes the API down with it.

## Develop without Docker

```sh
npm install
cp .env.example .env
docker compose up -d postgres mock-web   # just the dependencies
npm run db:migrate
npm run dev:api      # http://localhost:3001
npm run dev:worker
npm run dev:web      # http://localhost:3000
```

Checks: `npm run typecheck`, `npm test`, `npm run lint -w @lp/web`.

## Layout

```text
apps/
  api/        Express API (bundled with tsup)
  worker/     background jobs: heartbeat now, collectors from step 2
  web/        Next.js 16 dashboard (standalone output)
packages/
  shared/     domain constants and Zod env schemas
  db/         Drizzle schema, migrations (drizzle/), client, migrate CLI
Dockerfile    one file, targets api | worker | web
```

Workspace packages are plain TypeScript source (`"exports": "./src/index.ts"`). `tsx` runs them in development, tsup bundles them into each app's `dist/` for production, and Next.js compiles them itself. npm dependencies are never bundled; `tsup.preset.ts` keeps them external.

## Changing the database

1. Edit `packages/db/src/schema.ts`.
2. `npm run db:generate` writes a new SQL file to `packages/db/drizzle/`. Read it before committing.
3. `npm run db:migrate` applies it locally. In Docker, the `migrate` service applies it on the next `up`.

## Notes

- After creating a new workspace's `package.json`, run `npm install` once before `npm i <pkg> -w <name>`. Otherwise npm silently skips the install.
- `npm audit` reports moderate advisories in esbuild's dev server, which comes in through drizzle-kit and tsup. This project never starts that server.
- Next.js 16 ships its docs in `node_modules/next/dist/docs/`; see `apps/web/AGENTS.md`.
