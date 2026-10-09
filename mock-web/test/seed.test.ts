import { describe, expect, it } from 'vitest';
import { generateCorpus } from '../src/seed/generate.js';
import { CATEGORIES, SENTIMENTS } from '../src/seed/types.js';
import { buildBank } from '../src/seed/vocab.js';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const DAY = 86_400_000;

describe('seed corpus', () => {
  const corpus = generateCorpus(42, NOW);

  it('has at least 15 templates per category and sentiment', () => {
    const bank = buildBank();
    let total = 0;
    for (const c of CATEGORIES) {
      for (const s of SENTIMENTS) {
        expect(new Set(bank[c][s]).size).toBeGreaterThanOrEqual(15);
        total += bank[c][s].length;
      }
    }
    expect(total).toBeGreaterThanOrEqual(270);
  });

  it('has the specified volumes', () => {
    expect(corpus.factory.authors).toHaveLength(1500);
    expect(new Set(corpus.factory.authors.map((a) => a.username)).size).toBe(1500);
    expect(corpus.threadit.posts).toHaveLength(4000);
    expect(corpus.threadit.communities).toHaveLength(11);
    for (const p of corpus.threadit.posts) expect(p.comments.length).toBeLessThanOrEqual(12);
    expect(corpus.agora.topics).toHaveLength(800);
    for (const t of corpus.agora.topics) {
      expect(t.posts.length).toBeGreaterThanOrEqual(3);
      expect(t.posts.length).toBeLessThanOrEqual(40);
    }
    expect(corpus.ratewell.companies).toHaveLength(40);
    for (const c of corpus.ratewell.companies) expect(c.reviews).toHaveLength(150);
    expect(corpus.chirp.posts).toHaveLength(15000);
  });

  it('dates items within the 90 days before now, denser recently', () => {
    const dates = corpus.chirp.posts.map((p) => p.created);
    expect(Math.max(...dates)).toBeLessThanOrEqual(NOW);
    expect(Math.min(...dates)).toBeGreaterThanOrEqual(NOW - 90 * DAY);
    const lastWeek = dates.filter((d) => d > NOW - 7 * DAY).length;
    const firstWeek = dates.filter((d) => d < NOW - 83 * DAY).length;
    expect(lastWeek).toBeGreaterThan(firstWeek * 2);
  });

  it('keeps ratings consistent with sentiment', () => {
    for (const c of corpus.ratewell.companies) {
      for (const r of c.reviews) {
        const s = corpus.truth.get(r.id)!.sentiment;
        if (s === 'negative') expect(r.rating).toBeLessThanOrEqual(2);
        if (s === 'neutral') expect(r.rating).toBe(3);
        if (s === 'positive') expect(r.rating).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('puts a country on about 60% of Chirp posts', () => {
    const share = corpus.chirp.posts.filter((p) => p.country).length / corpus.chirp.posts.length;
    expect(share).toBeGreaterThan(0.55);
    expect(share).toBeLessThan(0.65);
  });

  it('has about 1% empty, 1% odd-character and 2% duplicated texts', () => {
    const texts = corpus.chirp.posts.map((p) => p.text);
    const empty = texts.filter((t) => t === '').length / texts.length;
    const odd = texts.filter((t) => /[^\x00-\x7f]/.test(t)).length / texts.length;
    expect(empty).toBeGreaterThan(0.005);
    expect(empty).toBeLessThan(0.02);
    expect(odd).toBeGreaterThan(0.005);
    expect(odd).toBeLessThan(0.03);

    const elsewhere = new Set<string>();
    for (const p of corpus.threadit.posts) for (const c of p.comments) elsewhere.add(c.body);
    for (const t of corpus.agora.topics) for (const p of t.posts) elsewhere.add(p.text);
    const dup = texts.filter((t) => t && elsewhere.has(t)).length / texts.length;
    expect(dup).toBeGreaterThan(0.01);
  });

  it('mixes sentiment differently by topic and country', () => {
    const share = new Map<string, [number, number]>();
    for (const t of corpus.truth.values()) {
      const key = `${t.topic}|${t.country}`;
      const [pos, all] = share.get(key) ?? [0, 0];
      share.set(key, [pos + (t.sentiment === 'positive' ? 1 : 0), all + 1]);
    }
    const ratios = [...share.values()].map(([p, a]) => p / a);
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeGreaterThan(0.15);
  });

  it('is identical for the same seed and different for another', () => {
    const again = generateCorpus(42, NOW);
    expect(again.chirp.posts.slice(0, 50)).toEqual(corpus.chirp.posts.slice(0, 50));
    expect([...again.truth.values()].slice(0, 500)).toEqual([...corpus.truth.values()].slice(0, 500));
    const other = generateCorpus(7, NOW);
    expect(other.chirp.posts[0]!.text).not.toEqual(corpus.chirp.posts[0]!.text);
  });
});
