// Values shared by the database schema, the API and the worker.

export const SITES = ['threadit', 'agora', 'ratewell', 'chirp'] as const;
export type Site = (typeof SITES)[number];

/** How a source is fetched, cheapest first; also the escalation ladder. */
export const STRATEGIES = ['api', 'html', 'browser', 'unblocker'] as const;
export type Strategy = (typeof STRATEGIES)[number];

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_TRIGGERS = ['schedule', 'manual', 'reparse'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** What a failure means, which decides what happens next. */
export const ERROR_CLASSES = ['transient', 'rate_limited', 'auth', 'blocked', 'quota', 'parse', 'bad_request'] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

export const SCORE_METHODS = ['rules', 'llm'] as const;
export type ScoreMethod = (typeof SCORE_METHODS)[number];

export const CATEGORIES = ['price', 'quality', 'customer service', 'reliability', 'usability', 'delivery'] as const;
export type Category = (typeof CATEGORIES)[number];

export const SENTIMENTS = ['negative', 'neutral', 'positive'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

/** A worker counts as alive if it wrote a heartbeat this recently. */
export const WORKER_STALE_AFTER_MS = 30_000;
