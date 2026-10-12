import { describe, expect, it } from 'vitest';
import { normalizeText, textHash, withTitle } from '../src/normalize';
import { ThreaditCollector } from '../src/threadit/collector';

const collector = new ThreaditCollector(
  { community: 'gb', pageSize: 100, includeComments: true, commentLookbackHours: 72 },
  { baseUrl: 'http://mock-web:4000', threadit: { clientId: 'a', clientSecret: 'b' } },
);
const raw = (url: string, body: unknown) => ({ url, status: 200, headers: {}, body: JSON.stringify(body), fetchedAt: new Date() });

const postData = {
  id: 't3_000123',
  community: 'gb',
  title: 'Thoughts on Ledgerly app?',
  selftext: 'The Ledgerly app is fairly standard.',
  author: 'quiet_harbor_41',
  created_utc: 1791000000,
  score: 3,
  num_comments: 2,
  permalink: '/threadit/c/gb/posts/t3_000123',
};

describe('Threadit parse', () => {
  it('turns a listing into items with title + body, author, date and community country', () => {
    const items = collector.parse(raw('http://mock-web:4000/threadit/c/gb/new?limit=100', { data: { children: [{ kind: 't3', data: postData }], after: null } }));
    expect(items).toEqual([
      {
        externalId: 't3_000123',
        author: 'quiet_harbor_41',
        text: 'Thoughts on Ledgerly app? The Ledgerly app is fairly standard.',
        country: 'GB',
        publishedAt: new Date(1791000000 * 1000),
        meta: { score: 3, numComments: 2 },
      },
    ]);
  });

  it('keeps country null for topic communities and for comments', () => {
    const topic = collector.parse(
      raw('http://mock-web:4000/threadit/c/online_banks/new', { data: { children: [{ kind: 't3', data: { ...postData, community: 'online_banks', selftext: '' } }], after: null } }),
    );
    expect(topic[0]).toMatchObject({ country: null, text: 'Thoughts on Ledgerly app?' });

    const comments = collector.parse(
      raw('http://mock-web:4000/threadit/posts/t3_000123/comments?limit=100', {
        data: { children: [{ kind: 't1', data: { id: 't1_000001', post_id: 't3_000123', body: 'Agreed.', author: 'a', created_utc: 1, score: 0 } }], after: null },
      }),
    );
    expect(comments[0]).toMatchObject({ externalId: 't1_000001', country: null, text: 'Agreed.' });
  });

  it('fails as a parse error when the layout changes (selftext renamed body_text)', () => {
    const { selftext, ...rest } = postData;
    void selftext;
    expect(() =>
      collector.parse(raw('http://mock-web:4000/threadit/c/gb/new', { data: { children: [{ kind: 't3', data: { ...rest, body_text: 'x' } }], after: null } })),
    ).toThrow(expect.objectContaining({ errorClass: 'parse' }));
  });

  it('fails as a parse error on non-JSON and on unknown URLs', () => {
    expect(() => collector.parse({ ...raw('http://mock-web:4000/threadit/c/gb/new', {}), body: '<html>' })).toThrow(
      expect.objectContaining({ errorClass: 'parse' }),
    );
    expect(() => collector.parse(raw('http://mock-web:4000/elsewhere', {}))).toThrow(expect.objectContaining({ errorClass: 'parse' }));
  });
});

describe('normalisation', () => {
  it('strips tags, decodes entities and collapses whitespace', () => {
    expect(normalizeText('<p>Fish &amp; chips</p>\n\n<p>&#8364;5 &nbsp; only</p>')).toBe('Fish & chips €5 only');
  });

  it('gives cross-site copies the same hash regardless of case and spacing', () => {
    expect(textHash('Great  value.')).toBe(textHash('<p>great value.</p>'));
    expect(textHash('Great value.')).not.toBe(textHash('Poor value.'));
  });
});

describe('withTitle', () => {
  it('separates a title from its body with a full stop unless the title already ends a sentence', () => {
    expect(withTitle('Voltra pricing is a joke', 'The price is too high.')).toBe('Voltra pricing is a joke. The price is too high.');
    expect(withTitle('Thoughts on Voltra?', 'It is fine.')).toBe('Thoughts on Voltra? It is fine.');
    expect(withTitle('  Only a title  ', '  ')).toBe('Only a title');
  });
});
