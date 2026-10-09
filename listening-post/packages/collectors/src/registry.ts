import { SOURCE_CONFIGS, type Site } from '@lp/shared';
import { AgoraCollector } from './agora/collector';
import { CollectorError } from './errors';
import { ThreaditCollector } from './threadit/collector';
import type { Collector, CollectorDeps } from './types';

export interface SourceLike {
  site: Site;
  config: unknown;
}

/** A fresh collector for one run. Invalid config fails the run as `bad_request`, without retries. */
export function createCollector(source: SourceLike, deps: CollectorDeps): Collector {
  switch (source.site) {
    case 'threadit': {
      const parsed = SOURCE_CONFIGS.threadit.safeParse(source.config);
      if (!parsed.success) throw new CollectorError('bad_request', `invalid threadit config: ${parsed.error.issues[0]?.message}`);
      return new ThreaditCollector(parsed.data, deps) as Collector;
    }
    case 'agora': {
      const parsed = SOURCE_CONFIGS.agora.safeParse(source.config);
      if (!parsed.success) throw new CollectorError('bad_request', `invalid agora config: ${parsed.error.issues[0]?.message}`);
      return new AgoraCollector(parsed.data, deps) as Collector;
    }
    default:
      throw new CollectorError('bad_request', `no collector for site ${source.site} yet`);
  }
}
