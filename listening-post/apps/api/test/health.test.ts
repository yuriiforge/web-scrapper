import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { HealthDeps } from '../src/health/health';
import { HealthModule } from '../src/health/health.module';
import { configureApp } from '../src/setup';
import { DB, HEALTH_DEPS } from '../src/tokens';

const NOW = Date.parse('2026-10-09T12:00:00Z');
let app: INestApplication | undefined;

async function boot(deps: Omit<HealthDeps, 'now'>): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [HealthModule],
    providers: [{ provide: DB, useValue: {} }],
  })
    .overrideProvider(HEALTH_DEPS)
    .useValue({ ...deps, now: () => NOW })
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health', () => {
  it('is ok when the database answers and a worker beat recently', async () => {
    const a = await boot({ pingDb: async () => {}, latestHeartbeat: async () => ({ workerId: 'w1', lastSeen: new Date(NOW - 5_000) }) });
    const res = await request(a.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.worker).toMatchObject({ ok: true, workerId: 'w1', ageMs: 5_000 });
  });

  it('is degraded, still 200, when the worker heartbeat is stale', async () => {
    const a = await boot({ pingDb: async () => {}, latestHeartbeat: async () => ({ workerId: 'w1', lastSeen: new Date(NOW - 60_000) }) });
    const res = await request(a.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.worker.ok).toBe(false);
  });

  it('is degraded when no worker has ever run', async () => {
    const a = await boot({ pingDb: async () => {}, latestHeartbeat: async () => null });
    expect((await request(a.getHttpServer()).get('/health').expect(200)).body.status).toBe('degraded');
  });

  it('is down with 503 when the database is unreachable', async () => {
    const a = await boot({
      pingDb: async () => {
        throw new Error('connect ECONNREFUSED');
      },
      latestHeartbeat: async () => null,
    });
    const res = await request(a.getHttpServer()).get('/health').expect(503);
    expect(res.body).toMatchObject({ status: 'down', checks: { database: { ok: false, error: 'connect ECONNREFUSED' } } });
  });

  it('returns JSON errors in the { error } shape for unknown routes', async () => {
    const a = await boot({ pingDb: async () => {}, latestHeartbeat: async () => null });
    expect((await request(a.getHttpServer()).get('/api/nope').expect(404)).body).toEqual({ error: 'not_found' });
    expect(a.getHttpAdapter().getInstance().get('x-powered-by')).toBeFalsy();
  });
});
