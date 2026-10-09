import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { boot } from './helpers.js';

describe('scaffold', () => {
  const { app } = boot();

  it('GET /_health reports status, seed and item count', async () => {
    const res = await request(app).get('/_health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.seed).toBe(42);
    expect(res.body.items).toBeGreaterThan(60_000);
  });

  it('GET / links to every site', async () => {
    const res = await request(app).get('/').expect(200);
    for (const site of ['threadit', 'agora', 'ratewell', 'passgate', 'chirp']) expect(res.text).toContain(`href="/${site}/"`);
  });

  it('config applies defaults and rejects bad values', () => {
    const c = loadConfig({});
    expect(c.port).toBe(4000);
    expect(c.threadit.tokenTtl).toBe(300);
    expect(c.passgate.credits).toBe(2000);
    expect(() => loadConfig({ MOCK_NOW: 'yesterday' })).toThrow(/MOCK_NOW/);
    expect(() => loadConfig({ THREADIT_RATE: '0' })).toThrow(/THREADIT_RATE/);
  });

  it('logs site requests but not admin or health', async () => {
    const { app: fresh } = boot();
    await request(fresh).get('/_health');
    await request(fresh).get('/agora/');
    await request(fresh).get('/agora/admin/');
    const res = await request(fresh).get('/_admin/requests').expect(200);
    expect(res.body.total).toBe(2);
    expect(res.body.counts.agora).toEqual({ '200': 1, '403': 1 });
    expect(res.body.peak_rps).toBeGreaterThanOrEqual(1);
    expect(res.body.entries.at(-1).path).toBe('/agora/admin/');
  });
});
