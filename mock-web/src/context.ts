import { randomBytes } from 'node:crypto';
import { pino, type Logger } from 'pino';
import type { Config } from './config.js';
import { generateCorpus } from './seed/generate.js';
import type { Corpus } from './seed/types.js';
import { RequestLog, createState, type State } from './state.js';

/** Wall clock for tokens, rate limits and sessions. Tests move it with `offsetMs`. */
export class Clock {
  offsetMs = 0;

  now(): number {
    return Date.now() + this.offsetMs;
  }
}

export interface Ctx {
  config: Config;
  log: Logger;
  clock: Clock;
  /** Header value PassGate uses to mark its own requests to the target sites. */
  internalSecret: string;
  corpus: Corpus;
  state: State;
  /** "Now" on the corpus timeline: MOCK_NOW plus time elapsed since boot or reset. */
  corpusNow(): number;
  /** Regenerates the corpus and clears tokens, sessions, rate buckets, credits and chaos. */
  reset(): void;
}

export function createContext(config: Config): Ctx {
  const clock = new Clock();
  const requests = new RequestLog();
  let bootAt = clock.now();
  let mockNow = config.mockNow ?? bootAt;

  const ctx: Ctx = {
    config,
    log: pino({ level: config.logLevel }),
    clock,
    internalSecret: randomBytes(16).toString('hex'),
    corpus: generateCorpus(config.seed, mockNow),
    state: createState(config, requests),
    corpusNow: () => Math.floor((mockNow + clock.now() - bootAt) / 1000) * 1000,
    reset() {
      bootAt = clock.now();
      mockNow = config.mockNow ?? bootAt;
      ctx.corpus = generateCorpus(config.seed, mockNow);
      ctx.state = createState(config, requests);
    },
  };
  return ctx;
}
