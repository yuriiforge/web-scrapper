import { load } from 'cheerio';
import { z } from 'zod';
import { CollectorError } from '../errors';
import { withTitle } from '../normalize';
import type { ParsedItem, RawResponse } from '../types';

// Reviews reach the collector four ways: the data JSON directly (plain HTTP or captured from the
// browser), the same JSON relayed by PassGate, or a page PassGate rendered to HTML. All four
// become the same items.

export interface Review {
  id: string;
  rating: number;
  title: string;
  body: string;
  author: string;
  country: string;
  createdAt: string;
  verified: boolean | null;
}

export interface ReviewPage {
  reviews: Review[];
  hasMore: boolean;
}

const dataJson = z.object({
  page: z.number().int(),
  has_more: z.boolean(),
  reviews: z.array(
    z.object({
      id: z.string(),
      rating: z.number().int().min(1).max(5),
      title: z.string(),
      body: z.string(),
      author: z.string(),
      country: z.string(),
      created_at: z.string(),
      verified: z.boolean(),
    }),
  ),
});

export function parseReviewsJson(raw: RawResponse): ReviewPage {
  let json: unknown;
  try {
    json = JSON.parse(raw.body);
  } catch {
    fail(raw, 'invalid JSON');
  }
  const r = dataJson.safeParse(json);
  if (!r.success) {
    const issue = r.error.issues[0];
    fail(raw, `unexpected shape at ${issue?.path.join('.')}: ${issue?.message}`);
  }
  return {
    reviews: r.data.reviews.map((v) => ({
      id: v.id,
      rating: v.rating,
      title: v.title,
      body: v.body,
      author: v.author,
      country: v.country,
      createdAt: v.created_at,
      verified: v.verified,
    })),
    hasMore: r.data.has_more,
  };
}

/** A company page PassGate rendered, with the reviews already in `div#reviews`. */
export function parseRenderedHtml(raw: RawResponse): ReviewPage {
  const $ = load(raw.body);
  if ($('div#reviews').length === 0) fail(raw, 'no div#reviews');
  const reviews = $('article.review')
    .toArray()
    .map((el) => {
      const a = $(el);
      const id = a.attr('data-id');
      const rating = Number(a.find('.review-rating').attr('data-rating'));
      const body = a.find('.review-body');
      const createdAt = a.find('time[datetime]').attr('datetime');
      if (!id || !Number.isInteger(rating) || !createdAt) fail(raw, `incomplete review ${id ?? '(no id)'}`);
      if (body.length === 0) fail(raw, `review ${id} has no .review-body`);
      return {
        id,
        rating,
        title: a.find('.review-title').text().trim(),
        body: body.text().trim(),
        author: a.find('.review-author').text().trim(),
        country: a.find('.review-country').text().trim(),
        createdAt,
        verified: null,
      };
    });
  return { reviews, hasMore: $('#load-more').length > 0 };
}

/** Which of the four shapes a stored response is, from its URL. Null when it carries no reviews. */
export function parseAnyReviewPage(raw: RawResponse): ReviewPage | null {
  const u = new URL(raw.url);
  if (u.pathname.endsWith('/passgate/v1/fetch')) {
    const target = u.searchParams.get('url') ?? '';
    if (u.searchParams.get('render') === 'true') return parseRenderedHtml(raw);
    if (target.includes('/ratewell/_data/')) return parseReviewsJson(raw);
    return null;
  }
  if (u.pathname.includes('/ratewell/_data/company/')) return parseReviewsJson(raw);
  return null;
}

export function reviewToItem(r: Review): ParsedItem {
  return {
    externalId: r.id,
    author: r.author || null,
    text: withTitle(r.title, r.body),
    country: /^[A-Z]{2}$/.test(r.country) ? r.country : null,
    publishedAt: new Date(r.createdAt),
    meta: r.verified === null ? { rating: r.rating } : { rating: r.rating, verified: r.verified },
  };
}

function fail(raw: RawResponse, why: string): never {
  throw new CollectorError('parse', `${raw.url}: ${why}`, raw.status, [raw]);
}
