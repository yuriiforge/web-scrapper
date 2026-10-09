import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { HealthDeps } from '../src/health';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const log = pino({ level: 'silent' });
const app = (health: Omit<HealthDeps, 'now'>) => createApp({ log, health: { ...health, now: () => NOW } });

describe('GET /health', () => {
  it('is ok when the database answers and a worker beat recently', async () => {
    const res = await request(
      app({ pingDb: async () => {}, latestHeartbeat: async () => ({ workerId: 'w1', lastSeen: new Date(NOW - 5_000) }) }),
    )
      .get('/health')
      .expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.worker).toMatchObject({ ok: true, workerId: 'w1', ageMs: 5_000 });
  });

  it('is degraded, still 200, when the worker heartbeat is stale or missing', async () => {
    const stale = await request(
      app({ pingDb: async () => {}, latestHeartbeat: async () => ({ workerId: 'w1', lastSeen: new Date(NOW - 60_000) }) }),
    )
      .get('/health')
      .expect(200);
    expect(stale.body.status).toBe('degraded');
    expect(stale.body.checks.worker.ok).toBe(false);

    const none = await request(app({ pingDb: async () => {}, latestHeartbeat: async () => null })).get('/health').expect(200);
    expect(none.body.status).toBe('degraded');
  });

  it('is down with 503 when the database is unreachable', async () => {
    const res = await request(
      app({
        pingDb: async () => {
          throw new Error('connect ECONNREFUSED');
        },
        latestHeartbeat: async () => null,
      }),
    )
      .get('/health')
      .expect(503);
    expect(res.body).toMatchObject({ status: 'down', checks: { database: { ok: false, error: 'connect ECONNREFUSED' } } });
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await request(app({ pingDb: async () => {}, latestHeartbeat: async () => null })).get('/nope').expect(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});
