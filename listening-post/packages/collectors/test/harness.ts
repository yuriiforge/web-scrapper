// Shared setup for integration tests: a fresh test database and an in-process mock-web.
import type { Server } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { clients, createDb, runMigrations, sources, type DbHandle } from '@lp/db';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { pino } from 'pino';
import { PgRateLimiter } from '../src/limiter';
import type { ExecutorDeps } from '../src/run';

const ADMIN_URL = process.env.INTEGRATION_ADMIN_URL ?? 'postgres://lp:lp@localhost:5432/postgres';
const TEST_DB = 'listening_post_test';
const ROOT = path.resolve(import.meta.dirname, '../../..');
const MOCK_WEB = process.env.MOCK_WEB_DIR ?? path.resolve(ROOT, '../mock-web');

/** Drops and recreates the test database, applies migrations, and returns a connection. */
export async function freshDatabase(): Promise<DbHandle> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(`Integration tests need Postgres at ${ADMIN_URL}. Start it with: docker compose up -d postgres\n${String(err)}`);
  }
  await admin.query(`drop database if exists ${TEST_DB} with (force)`);
  await admin.query(`create database ${TEST_DB}`);
  await admin.end();
  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DB}`);
  await runMigrations(url, path.join(ROOT, 'packages/db/drizzle'));
  return createDb(url);
}

export async function truncateAll(handle: DbHandle): Promise<void> {
  await handle.db.execute(
    sql`truncate items, raw_responses, runs, checkpoints, rate_buckets, sources, clients restart identity cascade`,
  );
}

interface MockWebModule {
  createApp(config: unknown): { app: { listen(port: number, cb: () => void): Server }; ctx: MockCtx };
}
interface MockConfigModule {
  loadConfig(env: Record<string, string>): unknown;
}
/** The parts of mock-web's context the tests look at. */
export interface MockCtx {
  corpus: { threadit: { posts: { id: string; community: string; comments: { id: string }[] }[] } };
  state: { requests: { entries: { path: string; status: number; site: string }[] } };
}

export interface MockWeb {
  url: string;
  ctx: MockCtx;
  admin(method: 'PUT' | 'POST', path: string, body: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/** Starts mock-web from the sibling folder on a random port, with the given env overrides. */
export async function startMockWeb(env: Record<string, string> = {}): Promise<MockWeb> {
  // Imported by path at run time, so mock-web's own sources are not type-checked against this project's settings.
  const { createApp } = (await import(pathToFileURL(path.join(MOCK_WEB, 'src/app.ts')).href)) as MockWebModule;
  const { loadConfig } = (await import(pathToFileURL(path.join(MOCK_WEB, 'src/config.ts')).href)) as MockConfigModule;
  const { app, ctx } = createApp(loadConfig({ SEED: '42', MOCK_NOW: '2026-10-07T12:00:00Z', LOG_LEVEL: 'silent', ...env }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    ctx,
    async admin(method, p, body) {
      const res = await fetch(`${url}/_admin${p}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`mock-web admin ${p}: ${res.status} ${await res.text()}`);
      return res.json();
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Executor dependencies pointed at a mock-web instance, with fast backoff for tests. */
export function executorDeps(handle: DbHandle, mock: MockWeb): ExecutorDeps {
  return {
    db: handle.db,
    log: pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' }),
    limiter: new PgRateLimiter(handle.db),
    defaultRatePerMinute: 100_000,
    rawRetentionDays: 30,
    collectorDeps: { baseUrl: mock.url, threadit: { clientId: 'dev-id', clientSecret: 'dev-secret' } },
    http: { baseDelayMs: 10 },
  };
}

export async function createSource(handle: DbHandle, config: Record<string, unknown>, name = 'test source'): Promise<string> {
  const [client] = await handle.db
    .insert(clients)
    .values({ name: `client for ${name}` })
    .onConflictDoUpdate({ target: clients.name, set: { name: sql`excluded.name` } })
    .returning({ id: clients.id });
  const [source] = await handle.db
    .insert(sources)
    // Tests run far faster than the real default rate allows, unless a test sets its own.
    .values({ clientId: client!.id, name, site: 'threadit', strategy: 'api', config: { ratePerMinute: 100_000, ...config } })
    .returning({ id: sources.id });
  return source!.id;
}
