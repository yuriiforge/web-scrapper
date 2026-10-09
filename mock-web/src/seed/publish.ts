import type { Rng } from '../lib/rng.js';
import { buildAgoraReply, buildChirp, buildReview, buildThreaditPost } from './build.js';
import { TOPIC_SLUGS, type ContentSite, type Corpus, type Topic } from './types.js';

/** Creates `count` new items dated `now` on one site and returns their ids. */
export function publish(corpus: Corpus, rng: Rng, site: ContentSite, count: number, topic: Topic | undefined, now: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    switch (site) {
      case 'threadit': {
        const post = buildThreaditPost(corpus, rng, now, topic);
        corpus.threadit.posts.unshift(post);
        ids.push(post.id);
        break;
      }
      case 'agora': {
        const topics = topic ? corpus.agora.topics.filter((t) => t.category === TOPIC_SLUGS[topic]) : corpus.agora.topics;
        ids.push(buildAgoraReply(corpus, rng, rng.pick(topics), now).id);
        break;
      }
      case 'ratewell': {
        const companies = topic ? corpus.ratewell.companies.filter((c) => c.topic === topic) : corpus.ratewell.companies;
        const company = rng.pick(companies);
        const review = buildReview(corpus, rng, company, now);
        company.reviews.unshift(review);
        ids.push(review.id);
        break;
      }
      case 'chirp': {
        const post = buildChirp(corpus, rng, now, topic);
        corpus.chirp.posts.unshift(post);
        ids.push(post.id);
        break;
      }
    }
  }
  return ids;
}
