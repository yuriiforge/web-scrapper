import type { Factory } from './factory.js';

export const TOPICS = ['electric cars', 'budget airlines', 'meal kits', 'fitness trackers', 'online banks'] as const;
export type Topic = (typeof TOPICS)[number];

export const CATEGORIES = ['price', 'quality', 'customer service', 'reliability', 'usability', 'delivery'] as const;
export type Category = (typeof CATEGORIES)[number];

export const SENTIMENTS = ['negative', 'neutral', 'positive'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const COUNTRIES = ['GB', 'DE', 'FR', 'US', 'PL', 'UA'] as const;
export type Country = (typeof COUNTRIES)[number];

/** URL slug of each topic; also the Agora category slug. */
export const TOPIC_SLUGS: Record<Topic, string> = {
  'electric cars': 'electric-cars',
  'budget airlines': 'budget-airlines',
  'meal kits': 'meal-kits',
  'fitness trackers': 'fitness-trackers',
  'online banks': 'online-banks',
};

/** Threadit topic community names. */
export const TOPIC_COMMUNITIES: Record<Topic, string> = {
  'electric cars': 'electric_cars',
  'budget airlines': 'budget_airlines',
  'meal kits': 'meal_kits',
  'fitness trackers': 'fitness_trackers',
  'online banks': 'online_banks',
};

export type ContentSite = 'threadit' | 'agora' | 'ratewell' | 'chirp';

export interface Truth {
  id: string;
  site: ContentSite;
  topic: Topic;
  category: Category;
  sentiment: Sentiment;
  country: Country;
}

export interface Author {
  id: string;
  username: string;
  /** Display name such as "M. Kowal". */
  name: string;
  country: Country;
}

export interface ThreaditComment {
  id: string;
  postId: string;
  body: string;
  author: string;
  created: number;
  score: number;
}

export interface ThreaditPost {
  id: string;
  community: string;
  title: string;
  body: string;
  author: string;
  created: number;
  score: number;
  /** Oldest first. */
  comments: ThreaditComment[];
}

export interface AgoraCategory {
  slug: string;
  name: string;
  topic: Topic;
}

export interface AgoraPost {
  id: string;
  topicId: string;
  postNumber: number;
  username: string;
  created: number;
  text: string;
  cooked: string;
}

export interface AgoraTopic {
  id: string;
  slug: string;
  title: string;
  topic: Topic;
  /** Category slug. */
  category: string;
  created: number;
  lastPosted: number;
  /** In post_number order. */
  posts: AgoraPost[];
}

export interface Review {
  id: string;
  company: string;
  rating: number;
  title: string;
  body: string;
  author: string;
  country: Country;
  created: number;
  verified: boolean;
}

export interface Company {
  slug: string;
  name: string;
  topic: Topic;
  /** Newest first. */
  reviews: Review[];
}

export interface ChirpPost {
  id: string;
  text: string;
  authorId: string;
  created: number;
  lang: string;
  country: Country | null;
  likes: number;
  replies: number;
  reposts: number;
}

export type IdKind = 't3' | 't1' | 'at' | 'ap' | 'rv' | 'ch';

export interface Corpus {
  seed: number;
  /** Epoch ms the corpus was dated against. */
  now: number;
  factory: Factory;
  threadit: {
    communities: string[];
    /** Newest first. */
    posts: ThreaditPost[];
    postById: Map<string, ThreaditPost>;
    commentById: Map<string, ThreaditComment>;
  };
  agora: {
    categories: AgoraCategory[];
    topics: AgoraTopic[];
    topicById: Map<string, AgoraTopic>;
  };
  ratewell: {
    companies: Company[];
    companyBySlug: Map<string, Company>;
  };
  chirp: {
    /** Newest first. */
    posts: ChirpPost[];
    postById: Map<string, ChirpPost>;
  };
  truth: Map<string, Truth>;
  /** Last index used per id prefix. */
  seq: Record<IdKind, number>;
}
