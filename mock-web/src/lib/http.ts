import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';

/** Thrown from handlers; the app error handler turns it into `status` + JSON `body`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error));
  }
}

export const badRequest = (field: string) => new HttpError(400, { error: 'bad_request', field });
export const notFound = () => new HttpError(404, { error: 'not_found' });

/** A query parameter, only when it was given exactly once as a string. */
export function qs(req: Request, name: string): string | undefined {
  const v = req.query[name];
  return typeof v === 'string' ? v : undefined;
}

/** Integer query parameter in [min, max]; throws 400 naming the field when invalid. */
export function intParam(req: Request, name: string, min: number, max: number, def: number): number {
  if (req.query[name] === undefined) return def;
  const v = qs(req, name);
  if (v === undefined || !/^\d+$/.test(v)) throw badRequest(name);
  const n = Number(v);
  if (n < min || n > max) throw badRequest(name);
  return n;
}

export function bearer(req: Request): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.get('authorization') ?? '');
  return m?.[1];
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/** Sends a 200 with a strong content ETag, or 304 with no body when If-None-Match matches. */
export function sendWithEtag(req: Request, res: Response, contentType: string, body: string): void {
  const etag = `"${createHash('sha1').update(body).digest('base64url')}"`;
  res.set('ETag', etag);
  const inm = req.get('if-none-match');
  if (inm) {
    const tags = inm.split(',').map((t) => t.trim().replace(/^W\//, ''));
    if (tags.includes(etag) || tags.includes('*')) {
      res.status(304).end();
      return;
    }
  }
  res.status(200).type(contentType).send(body);
}
