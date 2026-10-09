import { Faker, base, de, en, en_GB, en_US, fr, pl, uk, type LocaleDefinition } from '@faker-js/faker';
import { escapeHtml } from '../lib/format.js';
import { Rng, deriveSeed } from '../lib/rng.js';
import {
  CATEGORIES,
  COUNTRIES,
  SENTIMENTS,
  TOPICS,
  type Author,
  type Category,
  type Country,
  type Sentiment,
  type Topic,
} from './types.js';
import { BRANDS, CATEGORY_LABELS, DETAILS, ODDITIES, QUOTES, TITLES, buildBank, type SentenceBank } from './vocab.js';

const DAY_MS = 86_400_000;
const AUTHOR_COUNT = 1500;

const NAME_LOCALES: Record<Country, LocaleDefinition[]> = {
  GB: [en_GB, en, base],
  DE: [de, en, base],
  FR: [fr, en, base],
  US: [en_US, en, base],
  PL: [pl, en, base],
  UA: [uk, en, base],
};

export interface Composed {
  text: string;
  sentences: string[];
  brand: string;
}

/** Everything needed to make new items: authors, sentiment mixes and the text bank. */
export class Factory {
  readonly authors: Author[];
  readonly bank: SentenceBank = buildBank();
  private readonly mix = new Map<string, number[]>();

  constructor(seed: number) {
    this.authors = buildAuthors(seed);
    // Different sentiment mix per topic and country, so aggregates are not flat.
    const rng = new Rng(deriveSeed(seed, 'mix'));
    for (const topic of TOPICS) {
      for (const country of COUNTRIES) {
        this.mix.set(`${topic}|${country}`, [0.1 + rng.next() * 0.6, 0.1 + rng.next() * 0.4, 0.1 + rng.next() * 0.6]);
      }
    }
  }

  pickAuthor(rng: Rng): Author {
    return rng.pick(this.authors);
  }

  sentiment(rng: Rng, topic: Topic, country: Country): Sentiment {
    return SENTIMENTS[rng.weighted(this.mix.get(`${topic}|${country}`) as number[])] as Sentiment;
  }

  truthFor(rng: Rng, topic: Topic, country: Country, category?: Category): { category: Category; sentiment: Sentiment } {
    return { category: category ?? rng.pick(CATEGORIES), sentiment: this.sentiment(rng, topic, country) };
  }

  /**
   * 1 to `max` sentences; the first fixes the true category and sentiment.
   * About 10% mix in a second sentiment, 1% are empty and 1% get odd characters.
   */
  compose(
    rng: Rng,
    topic: Topic,
    category: Category,
    sentiment: Sentiment,
    min: number,
    max: number,
    maxLen = Infinity,
    brand = rng.pick(BRANDS[topic]),
  ): Composed {
    const n = rng.int(min, max);
    const sentences = [this.sentence(rng, topic, brand, category, sentiment)];
    for (let i = 1; i < n; i++) {
      // Retry a few times so one item rarely repeats a sentence.
      for (let attempt = 0; attempt < 4; attempt++) {
        const s = this.sentence(rng, topic, brand, rng.chance(0.7) ? category : rng.pick(CATEGORIES), sentiment);
        if (!sentences.includes(s)) {
          sentences.push(s);
          break;
        }
      }
    }
    if (rng.chance(0.1)) {
      const other = rng.pick(SENTIMENTS.filter((s) => s !== sentiment));
      const mixed = this.sentence(rng, topic, brand, rng.pick(CATEGORIES), other);
      if (sentences.length > 1) sentences[sentences.length - 1] = mixed;
      else sentences.push(mixed);
    }
    while (sentences.length > 1 && sentences.join(' ').length > maxLen) sentences.pop();

    const roll = rng.next();
    if (roll < 0.01) return { text: '', sentences: [], brand };
    if (roll < 0.02) sentences.push(rng.pick(ODDITIES));
    return { text: sentences.join(' '), sentences, brand };
  }

  title(rng: Rng, brand: string, category: Category, sentiment: Sentiment): string {
    return rng.pick(TITLES[sentiment]).replace('{brand}', brand).replace('{label}', CATEGORY_LABELS[category]);
  }

  /** Agora "cooked" HTML: paragraphs, with an occasional blockquote or link. */
  cook(rng: Rng, sentences: string[]): string {
    if (sentences.length === 0) return '';
    const paragraphs: string[] = [];
    for (let i = 0; i < sentences.length; ) {
      const take = rng.int(1, 2);
      paragraphs.push(`<p>${sentences.slice(i, i + take).map(escapeHtml).join(' ')}</p>`);
      i += take;
    }
    let html = paragraphs.join('');
    const r = rng.next();
    if (r < 0.08) html = `<blockquote><p>${escapeHtml(rng.pick(QUOTES))}</p></blockquote>${html}`;
    else if (r < 0.16) html += `<p>More notes <a href="https://example.org/notes/${rng.int(100, 999)}">here</a>.</p>`;
    return html;
  }

  /** A whole-second timestamp in the 90 days before `now`, denser in recent days. */
  date(rng: Rng, now: number): number {
    return Math.floor((now - Math.pow(rng.next(), 1.8) * 90 * DAY_MS) / 1000) * 1000;
  }

  /** A whole-second timestamp between `from` and `now`, skewed towards `from`. */
  after(rng: Rng, from: number, now: number, skew = 2): number {
    return from + Math.floor(((now - from) * Math.pow(rng.next(), skew)) / 1000) * 1000;
  }

  score(rng: Rng): number {
    return Math.floor(Math.pow(rng.next(), 3) * 1500) - rng.int(0, 10);
  }

  private sentence(rng: Rng, topic: Topic, brand: string, category: Category, sentiment: Sentiment): string {
    const s = rng
      .pick(this.bank[category][sentiment])
      .replace('{brand}', brand)
      .replace('{detail}', rng.pick(DETAILS[topic]));
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
}

function buildAuthors(seed: number): Author[] {
  const rng = new Rng(deriveSeed(seed, 'authors'));
  const words = new Faker({ locale: [en, base] });
  words.seed(deriveSeed(seed, 'usernames'));
  const names = new Map<Country, Faker>();
  for (const c of COUNTRIES) {
    const f = new Faker({ locale: NAME_LOCALES[c] });
    f.seed(deriveSeed(seed, `names:${c}`));
    names.set(c, f);
  }

  const clean = (w: string) => w.toLowerCase().replace(/[^a-z]/g, '').slice(0, 10);
  const used = new Set<string>();
  const authors: Author[] = [];
  for (let i = 0; i < AUTHOR_COUNT; i++) {
    const country = rng.pick(COUNTRIES);
    let username: string;
    do {
      username = `${clean(words.word.adjective())}_${clean(words.word.noun())}_${rng.int(10, 99)}`;
    } while (used.has(username));
    used.add(username);
    const f = names.get(country) as Faker;
    authors.push({
      id: `u_${String(i + 1).padStart(5, '0')}`,
      username,
      name: `${f.person.firstName().charAt(0)}. ${f.person.lastName()}`,
      country,
    });
  }
  return authors;
}
