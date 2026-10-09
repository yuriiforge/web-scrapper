import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { fnv1aHex } from '../src/lib/rng.js';

export const MOCK_NOW = '2026-10-07T12:00:00Z';

export const BROWSER = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  'Accept-Language': 'en-GB,en;q=0.9',
};

/** Boots an app with a fixed seed and clock; Agora's per-IP limit is raised unless a test sets it. */
export function boot(env: Record<string, string> = {}) {
  return createApp(loadConfig({ SEED: '42', MOCK_NOW, LOG_LEVEL: 'silent', AGORA_RATE: '1000', ...env }));
}

export async function threaditToken(app: Express): Promise<string> {
  const res = await request(app)
    .post('/threadit/api/v1/access_token')
    .auth('dev-id', 'dev-secret')
    .type('form')
    .send({ grant_type: 'client_credentials' })
    .expect(200);
  return res.body.access_token as string;
}

export interface RatewellSession {
  cookie: string;
  sid: string;
  nonce: string;
  token: string;
}

/** Loads a company page like a browser and computes the token app.js would send. */
export async function ratewellSession(app: Express, slug: string, cookie?: string): Promise<RatewellSession> {
  const req = request(app).get(`/ratewell/company/${slug}`).set(BROWSER);
  if (cookie) req.set('Cookie', cookie);
  const res = await req.expect(200);
  const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const header = cookie ?? setCookie.find((c) => c.startsWith('rw_sid='))!.split(';')[0]!;
  const sid = header.split('=')[1]!;
  const nonce = /nonce:\s*"([0-9a-f]+)"/.exec(res.text)![1]!;
  return { cookie: header, sid, nonce, token: fnv1aHex(`${nonce}:${sid}`) };
}

export function ratewellData(app: Express, slug: string, s: RatewellSession, page = 1) {
  return request(app)
    .get(`/ratewell/_data/company/${slug}/reviews?page=${page}`)
    .set(BROWSER)
    .set('Cookie', s.cookie)
    .set('X-RW-Nonce', s.nonce)
    .set('X-RW-Token', s.token);
}

export function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

export const admin = {
  chaos: (app: Express, site: string, body: Record<string, unknown>) => request(app).put(`/_admin/chaos/${site}`).send(body).expect(200),
  credits: (app: Express, site: string, balance: number) => request(app).post('/_admin/credits').send({ site, balance }).expect(200),
  publish: (app: Express, site: string, n: number, topic?: string) =>
    request(app).post('/_admin/publish').send({ site, count: n, topic }).expect(201),
};
