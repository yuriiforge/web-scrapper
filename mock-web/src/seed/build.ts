// Item builders shared by corpus generation and /_admin/publish.
import { slugify } from '../lib/format.js';
import type { Rng } from '../lib/rng.js';
import {
  TOPICS,
  TOPIC_COMMUNITIES,
  TOPIC_SLUGS,
  type AgoraPost,
  type AgoraTopic,
  type Category,
  type ChirpPost,
  type Company,
  type ContentSite,
  type Corpus,
  type Country,
  type IdKind,
  type Review,
  type Sentiment,
  type ThreaditComment,
  type ThreaditPost,
  type Topic,
} from './types.js';

const ID_WIDTH: Record<IdKind, number> = { t3: 6, t1: 6, at: 6, ap: 6, rv: 6, ch: 7 };

export function nextId(corpus: Corpus, kind: IdKind): string {
  corpus.seq[kind] += 1;
  return `${kind}_${String(corpus.seq[kind]).padStart(ID_WIDTH[kind], '0')}`;
}

function register(
  corpus: Corpus,
  id: string,
  site: ContentSite,
  topic: Topic,
  category: Category,
  sentiment: Sentiment,
  country: Country,
): void {
  corpus.truth.set(id, { id, site, topic, category, sentiment, country });
}

export function buildThreaditPost(corpus: Corpus, rng: Rng, created: number, topic?: Topic): ThreaditPost {
  const f = corpus.factory;
  const author = f.pickAuthor(rng);
  const t = topic ?? rng.pick(TOPICS);
  const community = rng.chance(0.5) ? author.country.toLowerCase() : TOPIC_COMMUNITIES[t];
  const { category, sentiment } = f.truthFor(rng, t, author.country);
  const c = f.compose(rng, t, category, sentiment, 1, 4);
  const post: ThreaditPost = {
    id: nextId(corpus, 't3'),
    community,
    title: f.title(rng, c.brand, category, sentiment),
    body: c.text,
    author: author.username,
    created,
    score: f.score(rng),
    comments: [],
  };
  register(corpus, post.id, 'threadit', t, category, sentiment, author.country);
  corpus.threadit.postById.set(post.id, post);
  return post;
}

export function buildThreaditComment(corpus: Corpus, rng: Rng, post: ThreaditPost, created: number): ThreaditComment {
  const f = corpus.factory;
  const parent = corpus.truth.get(post.id)!;
  const author = f.pickAuthor(rng);
  const { category, sentiment } = f.truthFor(rng, parent.topic, author.country, rng.chance(0.5) ? parent.category : undefined);
  const c = f.compose(rng, parent.topic, category, sentiment, 1, 3);
  const comment: ThreaditComment = {
    id: nextId(corpus, 't1'),
    postId: post.id,
    body: c.text,
    author: author.username,
    created,
    score: Math.floor(f.score(rng) / 10),
  };
  register(corpus, comment.id, 'threadit', parent.topic, category, sentiment, author.country);
  corpus.threadit.commentById.set(comment.id, comment);
  return comment;
}

/** A topic with its opening post and replies; `times` are ascending, one per post. */
export function buildAgoraTopic(corpus: Corpus, rng: Rng, topic: Topic, times: number[]): AgoraTopic {
  const f = corpus.factory;
  const author = f.pickAuthor(rng);
  const { category, sentiment } = f.truthFor(rng, topic, author.country);
  const c = f.compose(rng, topic, category, sentiment, 1, 4);
  const title = f.title(rng, c.brand, category, sentiment);
  const id = nextId(corpus, 'at');
  const t: AgoraTopic = {
    id,
    slug: slugify(title) || 'topic',
    title,
    topic,
    category: TOPIC_SLUGS[topic],
    created: times[0] as number,
    lastPosted: times[0] as number,
    posts: [],
  };
  register(corpus, id, 'agora', topic, category, sentiment, author.country);

  const first: AgoraPost = {
    id: nextId(corpus, 'ap'),
    topicId: id,
    postNumber: 1,
    username: author.username,
    created: t.created,
    text: c.text,
    cooked: f.cook(rng, c.sentences),
  };
  register(corpus, first.id, 'agora', topic, category, sentiment, author.country);
  t.posts.push(first);
  for (const time of times.slice(1)) buildAgoraReply(corpus, rng, t, time);
  corpus.agora.topicById.set(id, t);
  return t;
}

export function buildAgoraReply(corpus: Corpus, rng: Rng, t: AgoraTopic, created: number): AgoraPost {
  const f = corpus.factory;
  const lead = corpus.truth.get(t.id)!;
  const author = f.pickAuthor(rng);
  const { category, sentiment } = f.truthFor(rng, t.topic, author.country, rng.chance(0.5) ? lead.category : undefined);
  const c = f.compose(rng, t.topic, category, sentiment, 1, 4);
  const post: AgoraPost = {
    id: nextId(corpus, 'ap'),
    topicId: t.id,
    postNumber: t.posts.length + 1,
    username: author.username,
    created,
    text: c.text,
    cooked: f.cook(rng, c.sentences),
  };
  register(corpus, post.id, 'agora', t.topic, category, sentiment, author.country);
  t.posts.push(post);
  t.lastPosted = Math.max(t.lastPosted, created);
  return post;
}

const RATING: Record<Sentiment, [number, number]> = { negative: [1, 2], neutral: [3, 3], positive: [4, 5] };

export function buildReview(corpus: Corpus, rng: Rng, company: Company, created: number): Review {
  const f = corpus.factory;
  const author = f.pickAuthor(rng);
  const { category, sentiment } = f.truthFor(rng, company.topic, author.country);
  const c = f.compose(rng, company.topic, category, sentiment, 1, 4, Infinity, company.name);
  const [lo, hi] = RATING[sentiment];
  const review: Review = {
    id: nextId(corpus, 'rv'),
    company: company.slug,
    rating: rng.int(lo, hi),
    title: f.title(rng, c.brand, category, sentiment),
    body: c.text,
    author: author.name,
    country: author.country,
    created,
    verified: rng.chance(0.75),
  };
  register(corpus, review.id, 'ratewell', company.topic, category, sentiment, author.country);
  return review;
}

export function buildChirp(corpus: Corpus, rng: Rng, created: number, topic?: Topic): ChirpPost {
  const f = corpus.factory;
  const author = f.pickAuthor(rng);
  const t = topic ?? rng.pick(TOPICS);
  const { category, sentiment } = f.truthFor(rng, t, author.country);
  const c = f.compose(rng, t, category, sentiment, 1, 2, 280);
  const post: ChirpPost = {
    id: nextId(corpus, 'ch'),
    text: c.text,
    authorId: author.id,
    created,
    lang: 'en',
    country: rng.chance(0.6) ? author.country : null,
    likes: Math.floor(Math.pow(rng.next(), 3) * 500),
    replies: Math.floor(Math.pow(rng.next(), 3) * 60),
    reposts: Math.floor(Math.pow(rng.next(), 4) * 120),
  };
  register(corpus, post.id, 'chirp', t, category, sentiment, author.country);
  corpus.chirp.postById.set(post.id, post);
  return post;
}

