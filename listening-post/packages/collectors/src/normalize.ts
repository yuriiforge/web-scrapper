import { createHash } from 'node:crypto';

/** One shape for text from every site: no tags, decoded entities, single spaces, trimmed. */
export function normalizeText(input: string): string {
  return decodeEntities(input.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** SHA-256 of text after normalising and lower-casing; equal for cross-site copies. */
export function textHash(text: string): string {
  return createHash('sha256').update(normalizeText(text).toLowerCase()).digest('hex');
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return NAMED[code.toLowerCase()] ?? match;
  });
}

/**
 * A title followed by its body as one text, with a full stop between them when the title has no
 * ending punctuation, so "Thoughts on X?" stays as is and "X is great" does not run into the body.
 */
export function withTitle(title: string, body: string): string {
  const t = title.trim();
  if (!body.trim()) return t;
  return /[.!?:…]$/.test(t) ? `${t} ${body}` : `${t}. ${body}`;
}
