import { load } from 'cheerio';
import { z } from 'zod';
import { CollectorError } from '../errors';
import type { RawResponse } from '../types';

// Two parsers per page type, HTML and JSON, producing the same shapes. Each checks the markers
// it depends on and throws a parse error when one is missing, which is how a layout change shows up.

export interface TopicRef {
  id: string;
  title: string;
  postsCount: number;
  /** ISO timestamp of the last post; listings are sorted by it, newest first. */
  lastPostedAt: string;
}

export interface ListingPage {
  topics: TopicRef[];
  hasNext: boolean;
}

export interface TopicPost {
  id: string;
  postNumber: number;
  username: string;
  createdAt: string;
  /** The post body as an HTML fragment. */
  html: string;
}

export interface TopicPage {
  title: string;
  posts: TopicPost[];
  hasNext: boolean;
}

const listingJson = z.object({
  page: z.number().int(),
  per_page: z.number().int(),
  total_topics: z.number().int(),
  topics: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      posts_count: z.number().int(),
      last_posted_at: z.string(),
    }),
  ),
});

const topicJson = z.object({
  title: z.string(),
  posts_count: z.number().int(),
  page: z.number().int(),
  per_page: z.number().int(),
  posts: z.array(
    z.object({
      id: z.string(),
      post_number: z.number().int(),
      username: z.string(),
      created_at: z.string(),
      cooked: z.string(),
    }),
  ),
});

export function parseListingJson(raw: RawResponse): ListingPage {
  const d = decodeJson(raw, listingJson);
  return {
    topics: d.topics.map((t) => ({ id: t.id, title: t.title, postsCount: t.posts_count, lastPostedAt: t.last_posted_at })),
    hasNext: d.page * d.per_page < d.total_topics,
  };
}

export function parseTopicJson(raw: RawResponse): TopicPage {
  const d = decodeJson(raw, topicJson);
  return {
    title: d.title,
    posts: d.posts.map((p) => ({ id: p.id, postNumber: p.post_number, username: p.username, createdAt: p.created_at, html: p.cooked })),
    hasNext: d.page * d.per_page < d.posts_count,
  };
}

export function parseListingHtml(raw: RawResponse): ListingPage {
  const $ = load(raw.body);
  if ($('table.topic-list').length === 0) fail(raw, 'no table.topic-list');
  const topics = $('tr.topic-row')
    .toArray()
    .map((row) => {
      const r = $(row);
      const id = r.attr('data-topic-id');
      const title = r.find('a.topic-title').text().trim();
      const replies = r.find('.topic-replies').text().trim();
      const lastPostedAt = r.find('time[datetime]').attr('datetime');
      if (!id || !title || !/^\d+$/.test(replies) || !lastPostedAt) fail(raw, `incomplete topic row ${id ?? '(no id)'}`);
      return { id, title, postsCount: Number(replies) + 1, lastPostedAt };
    });
  return { topics, hasNext: $('a.next-page[rel="next"]').length > 0 };
}

export function parseTopicHtml(raw: RawResponse): TopicPage {
  const $ = load(raw.body);
  const title = $('h1.topic-heading').text().trim();
  if (!title) fail(raw, 'no h1.topic-heading');
  const posts = $('article.post')
    .toArray()
    .map((el) => {
      const a = $(el);
      const id = a.attr('data-post-id');
      const postNumber = Number(a.attr('data-post-number'));
      const username = a.find('.post-author').first().text().trim();
      const createdAt = a.find('time[datetime]').first().attr('datetime');
      const body = a.find('.post-body');
      if (!id || !Number.isInteger(postNumber) || !username || !createdAt) fail(raw, `incomplete post ${id ?? '(no id)'}`);
      if (body.length === 0) fail(raw, `post ${id} has no .post-body`);
      return { id, postNumber, username, createdAt, html: body.html() ?? '' };
    });
  return { title, posts, hasNext: $('a.next-page[rel="next"]').length > 0 };
}

function decodeJson<T extends z.ZodType>(raw: RawResponse, schema: T): z.infer<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw.body);
  } catch {
    fail(raw, 'invalid JSON');
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    fail(raw, `unexpected shape at ${issue?.path.join('.')}: ${issue?.message}`);
  }
  return result.data;
}

function fail(raw: RawResponse, why: string): never {
  throw new CollectorError('parse', `${raw.url}: ${why}`, raw.status, [raw]);
}
