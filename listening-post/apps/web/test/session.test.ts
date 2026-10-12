import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authEnabled, createSessionToken, passwordMatches, verifySessionToken } from '../src/lib/session';

describe('dashboard session', () => {
  beforeEach(() => {
    process.env.ADMIN_PASSWORD = 'correct horse';
    process.env.SESSION_SECRET = 'a-session-secret-of-some-length';
  });
  afterEach(() => {
    delete process.env.ADMIN_PASSWORD;
    delete process.env.SESSION_SECRET;
  });

  it('accepts a token it signed until it expires', () => {
    const now = Date.parse('2026-10-12T10:00:00Z');
    const token = createSessionToken(now);
    expect(verifySessionToken(token, now + 60_000)).toBe(true);
    expect(verifySessionToken(token, now + 13 * 3600_000)).toBe(false);
  });

  it('rejects forged, extended or malformed tokens', () => {
    const token = createSessionToken();
    const [expires, mac] = token.split('.');
    expect(verifySessionToken(`${Number(expires) + 86_400_000}.${mac}`)).toBe(false);
    expect(verifySessionToken(`${expires}.AAAA`)).toBe(false);
    expect(verifySessionToken('garbage')).toBe(false);
    expect(verifySessionToken(undefined)).toBe(false);
    process.env.SESSION_SECRET = 'a-different-secret-entirely!!';
    expect(verifySessionToken(token)).toBe(false);
  });

  it('checks the password, and is off when no password is set', () => {
    expect(passwordMatches('correct horse')).toBe(true);
    expect(passwordMatches('wrong')).toBe(false);
    expect(authEnabled()).toBe(true);
    delete process.env.ADMIN_PASSWORD;
    expect(authEnabled()).toBe(false);
    expect(passwordMatches('')).toBe(false);
  });
});
