import { describe, expect, it } from 'vitest';
import { isAllowed, parseRobots } from '../src/robots';

describe('robots.txt', () => {
  it("reads mock-web's Agora rules", () => {
    const rules = parseRobots('User-agent: *\nDisallow: /agora/admin/\nCrawl-delay: 1\nSitemap: /agora/sitemap.xml\n', 'ListeningPost');
    expect(rules).toEqual({ allow: [], disallow: ['/agora/admin/'], crawlDelaySeconds: 1 });
    expect(isAllowed(rules, '/agora/admin/')).toBe(false);
    expect(isAllowed(rules, '/agora/admin/users')).toBe(false);
    expect(isAllowed(rules, '/agora/latest')).toBe(true);
  });

  it('prefers the group that names this crawler over *', () => {
    const text = 'User-agent: *\nDisallow: /\n\nUser-agent: OtherBot\nUser-agent: listeningpost\nDisallow: /private\nCrawl-delay: 2.5';
    const rules = parseRobots(text, 'ListeningPost/0.1');
    expect(rules.crawlDelaySeconds).toBe(2.5);
    expect(isAllowed(rules, '/public')).toBe(true);
    expect(isAllowed(rules, '/private/x')).toBe(false);
  });

  it('lets the longest match win, with Allow winning ties', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /forum/\nAllow: /forum/public/', 'x');
    expect(isAllowed(rules, '/forum/secret')).toBe(false);
    expect(isAllowed(rules, '/forum/public/1')).toBe(true);
  });

  it('supports * wildcards and $ anchors, and ignores comments', () => {
    const rules = parseRobots('User-agent: * # everyone\nDisallow: /*.json$\nDisallow: /tmp*/cache', 'x');
    expect(isAllowed(rules, '/agora/t/1.json')).toBe(false);
    expect(isAllowed(rules, '/agora/t/1.json?page=2')).toBe(true);
    expect(isAllowed(rules, '/tmp2/cache/a')).toBe(false);
  });

  it('allows everything when empty, or when no group applies', () => {
    expect(isAllowed(parseRobots('', 'x'), '/anything')).toBe(true);
    expect(isAllowed(parseRobots('User-agent: OtherBot\nDisallow: /', 'ListeningPost'), '/anything')).toBe(true);
  });
});
