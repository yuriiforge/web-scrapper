import { createHmac, timingSafeEqual } from "node:crypto";

// A deliberately small admin login: one password (ADMIN_PASSWORD) and a signed session cookie.
// The cookie holds only an expiry time plus an HMAC of it, so it cannot be forged or extended
// without SESSION_SECRET. With ADMIN_PASSWORD unset, login is off (local development).

export const SESSION_COOKIE = "lp_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export function authEnabled(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD);
}

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("SESSION_SECRET must be set (16+ characters) when ADMIN_PASSWORD is set");
  return s;
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

export function createSessionToken(now = Date.now()): string {
  const expires = String(now + SESSION_TTL_SECONDS * 1000);
  return `${expires}.${sign(expires)}`;
}

export function verifySessionToken(token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const [expires, mac] = token.split(".");
  if (!expires || !mac || !/^\d+$/.test(expires) || Number(expires) < now) return false;
  return safeEqual(mac, sign(expires));
}

export function passwordMatches(given: string): boolean {
  const expected = process.env.ADMIN_PASSWORD ?? "";
  return expected !== "" && safeEqual(given, expected);
}

/** Constant-time comparison; lengths are compared via HMACs so they do not leak either. */
function safeEqual(a: string, b: string): boolean {
  const key = "compare";
  const ha = createHmac("sha256", key).update(a).digest();
  const hb = createHmac("sha256", key).update(b).digest();
  return timingSafeEqual(ha, hb);
}
