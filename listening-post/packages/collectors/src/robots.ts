/** The rules from robots.txt that apply to this crawler. */
export interface RobotsRules {
  allow: string[];
  disallow: string[];
  crawlDelaySeconds: number | null;
}

export const ALLOW_ALL: RobotsRules = { allow: [], disallow: [], crawlDelaySeconds: null };

/**
 * Parses robots.txt for one user agent: the group naming it (case-insensitive substring
 * match on the token) if there is one, otherwise the `*` group.
 */
export function parseRobots(text: string, userAgentToken: string): RobotsRules {
  const groups: { agents: string[]; rules: RobotsRules }[] = [];
  let current: { agents: string[]; rules: RobotsRules } | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const sep = line.indexOf(':');
    if (sep < 0) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === 'user-agent') {
      // Consecutive User-agent lines share one group.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: { allow: [], disallow: [], crawlDelaySeconds: null } };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'disallow' && value) current.rules.disallow.push(value);
    else if (field === 'allow' && value) current.rules.allow.push(value);
    else if (field === 'crawl-delay' && /^\d+(\.\d+)?$/.test(value)) current.rules.crawlDelaySeconds = Number(value);
  }

  const token = userAgentToken.toLowerCase();
  const own = groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  return (own ?? groups.find((g) => g.agents.includes('*')))?.rules ?? ALLOW_ALL;
}

/** Longest matching rule wins; on a tie, Allow wins. Supports `*` wildcards and a trailing `$`. */
export function isAllowed(rules: RobotsRules, path: string): boolean {
  const longest = (patterns: string[]) => Math.max(-1, ...patterns.filter((p) => matches(p, path)).map((p) => p.length));
  return longest(rules.allow) >= longest(rules.disallow);
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`).test(path);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
