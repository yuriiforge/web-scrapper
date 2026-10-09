import { slugify, splitSentences } from '../lib/format.js';
import { Rng, deriveSeed } from '../lib/rng.js';
import { buildAgoraTopic, buildChirp, buildReview, buildThreaditComment, buildThreaditPost } from './build.js';
import { Factory } from './factory.js';
import {
  COUNTRIES,
  TOPICS,
  TOPIC_COMMUNITIES,
  TOPIC_SLUGS,
  type ContentSite,
  type Corpus,
  type Topic,
} from './types.js';
import { BRANDS } from './vocab.js';

const VOLUME = {
  threaditPosts: 4000,
  agoraTopics: 800,
  reviewsPerCompany: 150,
  chirpPosts: 15000,
};

/** Builds the whole corpus from the seed alone; `now` is the epoch ms items are dated against. */
export function generateCorpus(seed: number, now: number): Corpus {
  const corpus: Corpus = {
    seed,
    now,
    factory: new Factory(seed),
    threadit: {
      communities: [...COUNTRIES.map((c) => c.toLowerCase()), ...TOPICS.map((t) => TOPIC_COMMUNITIES[t])],
      posts: [],
      postById: new Map(),
      commentById: new Map(),
    },
    agora: {
      categories: TOPICS.map((topic) => ({ slug: TOPIC_SLUGS[topic], name: titleCase(topic), topic })),
      topics: [],
      topicById: new Map(),
    },
    ratewell: { companies: [], companyBySlug: new Map() },
    chirp: { posts: [], postById: new Map() },
    truth: new Map(),
    seq: { t3: 0, t1: 0, at: 0, ap: 0, rv: 0, ch: 0 },
  };

  generateThreadit(corpus, new Rng(deriveSeed(seed, 'threadit')));
  generateAgora(corpus, new Rng(deriveSeed(seed, 'agora')));
  generateRatewell(corpus, new Rng(deriveSeed(seed, 'ratewell')));
  generateChirp(corpus, new Rng(deriveSeed(seed, 'chirp')));
  addNearDuplicates(corpus, new Rng(deriveSeed(seed, 'duplicates')));
  return corpus;
}

/** Newest first, ties broken by id descending. */
export function byNewest<T extends { created: number; id: string }>(a: T, b: T): number {
  return b.created - a.created || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

export function itemCounts(corpus: Corpus): Record<ContentSite, number> {
  let comments = 0;
  for (const p of corpus.threadit.posts) comments += p.comments.length;
  let agoraPosts = 0;
  for (const t of corpus.agora.topics) agoraPosts += t.posts.length;
  let reviews = 0;
  for (const c of corpus.ratewell.companies) reviews += c.reviews.length;
  return {
    threadit: corpus.threadit.posts.length + comments,
    agora: agoraPosts,
    ratewell: reviews,
    chirp: corpus.chirp.posts.length,
  };
}

function generateThreadit(corpus: Corpus, rng: Rng): void {
  const f = corpus.factory;
  for (let i = 0; i < VOLUME.threaditPosts; i++) {
    const post = buildThreaditPost(corpus, rng, f.date(rng, corpus.now));
    const times = Array.from({ length: rng.int(0, 12) }, () => f.after(rng, post.created, corpus.now)).sort((a, b) => a - b);
    for (const t of times) post.comments.push(buildThreaditComment(corpus, rng, post, t));
    corpus.threadit.posts.push(post);
  }
  corpus.threadit.posts.sort(byNewest);
}

function generateAgora(corpus: Corpus, rng: Rng): void {
  const f = corpus.factory;
  for (let i = 0; i < VOLUME.agoraTopics; i++) {
    const topic = rng.pick(TOPICS);
    const created = f.date(rng, corpus.now);
    const replies = Array.from({ length: rng.int(3, 40) - 1 }, () => f.after(rng, created, corpus.now, 1.6));
    corpus.agora.topics.push(buildAgoraTopic(corpus, rng, topic, [created, ...replies.sort((a, b) => a - b)]));
  }
}

function generateRatewell(corpus: Corpus, rng: Rng): void {
  const f = corpus.factory;
  for (const topic of TOPICS) {
    for (const name of BRANDS[topic]) {
      const company = { slug: slugify(name), name, topic, reviews: [] as ReturnType<typeof buildReview>[] };
      for (let i = 0; i < VOLUME.reviewsPerCompany; i++) {
        company.reviews.push(buildReview(corpus, rng, company, f.date(rng, corpus.now)));
      }
      company.reviews.sort(byNewest);
      corpus.ratewell.companies.push(company);
      corpus.ratewell.companyBySlug.set(company.slug, company);
    }
  }
}

function generateChirp(corpus: Corpus, rng: Rng): void {
  const f = corpus.factory;
  for (let i = 0; i < VOLUME.chirpPosts; i++) {
    corpus.chirp.posts.push(buildChirp(corpus, rng, f.date(rng, corpus.now)));
  }
  corpus.chirp.posts.sort(byNewest);
}

interface Slot {
  id: string;
  site: ContentSite;
  topic: Topic;
  author: string;
  text: () => string;
  setText: (text: string) => void;
}

/**
 * About 2% of comments, Agora replies and Chirp posts get the exact text of an item on
 * another site (same topic, different author), with matching ground truth.
 */
function addNearDuplicates(corpus: Corpus, rng: Rng): void {
  const f = corpus.factory;
  const usernameById = new Map(f.authors.map((a) => [a.id, a.username]));
  const slots: Slot[] = [];
  for (const post of corpus.threadit.posts) {
    const topic = corpus.truth.get(post.id)!.topic;
    for (const c of post.comments) {
      slots.push({ id: c.id, site: 'threadit', topic, author: c.author, text: () => c.body, setText: (t) => (c.body = t) });
    }
  }
  for (const t of corpus.agora.topics) {
    for (const p of t.posts.slice(1)) {
      slots.push({
        id: p.id,
        site: 'agora',
        topic: t.topic,
        author: p.username,
        text: () => p.text,
        setText: (text) => {
          p.text = text;
          p.cooked = f.cook(rng, splitSentences(text));
        },
      });
    }
  }
  for (const p of corpus.chirp.posts) {
    slots.push({
      id: p.id,
      site: 'chirp',
      topic: corpus.truth.get(p.id)!.topic,
      author: usernameById.get(p.authorId)!,
      text: () => p.text,
      setText: (t) => (p.text = t),
    });
  }

  const pool = new Map<Topic, Slot[]>(TOPICS.map((t) => [t, []]));
  for (const s of slots) {
    const len = s.text().length;
    if (len > 0 && len <= 280) pool.get(s.topic)!.push(s);
  }

  const sources = new Set<string>();
  const replaced = new Set<string>();
  for (const target of slots) {
    if (!rng.chance(0.02) || sources.has(target.id)) continue;
    const candidates = pool.get(target.topic)!;
    for (let attempt = 0; attempt < 5; attempt++) {
      const src = rng.pick(candidates);
      if (src.site === target.site || src.author === target.author || replaced.has(src.id)) continue;
      target.setText(src.text());
      const st = corpus.truth.get(src.id)!;
      const tt = corpus.truth.get(target.id)!;
      tt.category = st.category;
      tt.sentiment = st.sentiment;
      sources.add(src.id);
      replaced.add(target.id);
      break;
    }
  }
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
