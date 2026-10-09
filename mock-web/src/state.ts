import type { Config } from './config.js';
import { Rng, deriveSeed } from './lib/rng.js';

export const SITES = ['threadit', 'agora', 'ratewell', 'passgate', 'chirp'] as const;
export type SiteName = (typeof SITES)[number];

export interface ChaosSettings {
  errorRate: number;
  timeoutRate: number;
  latencyMs: number;
  emptyResults: boolean;
  layoutVersion: 1 | 2;
  /** Ratewell only. */
  botCheckLevel?: number;
}

export function defaultChaos(site: SiteName): ChaosSettings {
  const s: ChaosSettings = { errorRate: 0, timeoutRate: 0, latencyMs: 0, emptyResults: false, layoutVersion: 1 };
  if (site === 'ratewell') s.botCheckLevel = 1;
  return s;
}

export interface CreditAccount {
  remaining: number;
  used: number;
  requests: number;
}

export interface RatewellSession {
  /** nonce -> issued at (epoch ms). */
  nonces: Map<string, number>;
  webdriver: boolean;
  blockedUntil: number;
}

export interface LogEntry {
  ts: number;
  site: SiteName;
  method: string;
  path: string;
  /** 0 when the socket closed before a response was sent. */
  status: number;
  ms: number;
  ip: string;
  ua: string;
  via_passgate: boolean;
}

const LOG_CAP = 20_000;

/** Request log; survives /_admin/reset. */
export class RequestLog {
  entries: LogEntry[] = [];

  push(e: LogEntry): void {
    this.entries.push(e);
    if (this.entries.length > LOG_CAP + 1000) this.entries.splice(0, this.entries.length - LOG_CAP);
  }
}

export interface State {
  chaos: Record<SiteName, ChaosSettings>;
  /** Random stream for chaos decisions, separate from the corpus. */
  chaosRng: Rng;
  /** Random stream for /_admin/publish. */
  publishRng: Rng;
  /** Threadit access token -> expires at (epoch ms). */
  tokens: Map<string, number>;
  /** Rate-limit key -> request timestamps inside the current window. */
  buckets: Map<string, number[]>;
  /** Ratewell rw_sid -> session. */
  sessions: Map<string, RatewellSession>;
  credits: { passgate: CreditAccount; chirp: CreditAccount };
  requests: RequestLog;
}

export function createState(config: Config, requests = new RequestLog()): State {
  return {
    chaos: Object.fromEntries(SITES.map((s) => [s, defaultChaos(s)])) as Record<SiteName, ChaosSettings>,
    chaosRng: new Rng(deriveSeed(config.seed, 'chaos')),
    publishRng: new Rng(deriveSeed(config.seed, 'publish')),
    tokens: new Map(),
    buckets: new Map(),
    sessions: new Map(),
    credits: {
      passgate: { remaining: config.passgate.credits, used: 0, requests: 0 },
      chirp: { remaining: config.chirp.credits, used: 0, requests: 0 },
    },
    requests,
  };
}
