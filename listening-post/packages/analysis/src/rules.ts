import type { Category, Sentiment } from '@lp/shared';

export interface Score {
  category: Category | null;
  sentiment: Sentiment | null;
  /** 0 to 1: how far the winner is ahead of the runner-up. */
  confidence: number;
}

/**
 * Keyword cues per category. Multi-word cues are matched as phrases. Written for consumer reviews
 * in general (prices, support, apps, parcels), not copied from mock-web's sentence templates.
 */
const CATEGORY_CUES: Record<Category, readonly string[]> = {
  price: [
    'price', 'prices', 'pricing', 'priced', 'cost', 'costs', 'charge', 'charges', 'charged', 'fee', 'fees', 'expensive',
    'cheap', 'cheaper', 'overpriced', 'value', 'quote', 'quotes', 'money', 'paid', 'pay', 'afford', 'rip-off', 'subscription',
  ],
  quality: ['quality', 'build', 'built', 'finish on', 'premium', 'flimsy', 'durable', 'well made', 'fell apart', 'letdown', 'craftsmanship'],
  'customer service': [
    'customer service', 'support', 'helpdesk', 'help desk', 'agent', 'staff', 'rude', 'helpful', 'friendly', 'complaint',
    'answer', 'answered', 'getting help', 'passing me around', 'call centre', 'call center', 'refund',
  ],
  reliability: [
    'reliability', 'reliable', 'unreliable', 'dependability', 'dependable', 'consistency', 'consistent', 'count on',
    'let me down', 'rock solid', 'problems', 'hiccup', 'outage', 'broke down', 'crash', 'crashes', 'over time', 'day-to-day',
  ],
  usability: [
    'app', 'interface', 'setting up', 'set up', 'setup', 'intuitive', 'clunky', 'confusing', 'booking', 'easy to use',
    'user-friendly', 'menu', 'website', 'to use', 'using',
  ],
  delivery: [
    'delivery', 'delivered', 'deliveries', 'shipping', 'shipped', 'order', 'parcel', 'courier', 'arrived', 'arrival',
    'handover', 'dispatch', 'damaged', 'on time', 'window', 'tracking number',
  ],
};

/**
 * Sentiment cues: weight > 0 positive, < 0 negative, and 'neutral' for wording that marks a plain,
 * middling report ("about average", "as described"). Phrases come first and win over their words.
 */
const SENTIMENT_CUES: ReadonlyArray<readonly [string, number | 'neutral']> = [
  // Phrases whose words would mislead on their own.
  ['never let me down', 2], ['let me down', -2], ['no longer count on', -2], ['can always count on', 2],
  ['above and beyond', 2], ['nobody cared', -2], ['for no good reason', -1], ['far too high', -2], ['good value', 2],
  ['fell apart', -2], ['rip-off', -2], ['a joke', -2], ['shout-out', 2], ['pleasantly surprised', 2], ['without fixing', -1.5],
  ['faster than promised', 2],
  // Neutral wording.
  ['nothing to report', 'neutral'], ['nothing special', 'neutral'], ['no more', 'neutral'], ['getting used to', 'neutral'],
  ['about what i expected', 'neutral'], ['in line with', 'neutral'], ['neither', 'neutral'], ['as described', 'neutral'],
  ['within the stated', 'neutral'], ['on time', 'neutral'], ['the usual', 'neutral'], ['mostly fine', 'neutral'],
  ['about the same', 'neutral'], ['once you know', 'neutral'], ['average', 'neutral'], ['standard', 'neutral'],
  ['okay', 'neutral'], ['acceptable', 'neutral'], ['scripted', 'neutral'], ['so far', 'neutral'],
  // Single words.
  ['excellent', 2], ['fantastic', 2], ['brilliant', 2], ['great', 1.5], ['good', 1], ['fair', 1],
  ['intuitive', 1.5], ['effortless', 1.5], ['joy', 1.5], ['friendly', 1.5], ['smooth', 1.5], ['solid', 1], ['happy', 1.5],
  ['love', 2], ['exceeded', 1.5], ['quick', 1], ['perfectly', 1.5], ['beat', 1], ['recommend', 1.5],
  ['poor', -2], ['bad', -1.5], ['terrible', -2], ['worst', -2], ['awful', -2], ['rude', -2], ['useless', -2], ['late', -1.5],
  ['damaged', -2], ['letdown', -2], ['confusing', -1.5], ['clunky', -1.5], ['painful', -1.5], ['excuses', -1.5],
  ['disappointed', -2], ['avoid', -2], ['problems', -1.5], ['badly', -1.5], ['weeks', -1], ['overpriced', -2],
];

const NEGATORS = new Set(['not', 'never', 'no', "isn't", "wasn't", "don't", "didn't", 'hardly']);

/** Split into sentences; each weighs half the one before, since reviews usually lead with their point. */
function sentences(text: string): string[] {
  return text
    .toLowerCase()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function countPhrase(sentence: string, phrase: string): number[] {
  const at: number[] = [];
  const re = new RegExp(`(?<![\\w-])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g');
  for (const m of sentence.matchAll(re)) at.push(m.index);
  return at;
}

/** Whether one of the two words before `index` negates the cue. */
function negated(sentence: string, index: number): boolean {
  const before = sentence.slice(0, index).split(/\s+/).filter(Boolean).slice(-2);
  return before.some((w) => NEGATORS.has(w));
}

/** The baseline scorer: keyword cues, no model. Free and instant, so it scores every item. */
export function scoreRules(text: string): Score {
  const parts = sentences(text);
  const categoryScore = new Map<Category, number>();
  let positive = 0;
  let negative = 0;
  let neutral = 0;

  parts.forEach((raw, i) => {
    const weight = 1 / 2 ** i;
    for (const [category, cues] of Object.entries(CATEGORY_CUES) as [Category, readonly string[]][]) {
      for (const cue of cues) {
        const hits = countPhrase(raw, cue).length;
        if (hits) categoryScore.set(category, (categoryScore.get(category) ?? 0) + hits * weight * (cue.includes(' ') ? 1.5 : 1));
      }
    }
    // Blank out each matched phrase so its words are not counted again as single words.
    let s = raw;
    for (const [cue, value] of SENTIMENT_CUES) {
      for (const index of countPhrase(s, cue)) {
        if (value === 'neutral') {
          neutral += 1.5 * weight;
          continue;
        }
        const v = negated(s, index) && !cue.includes(' ') ? -value : value;
        if (v > 0) positive += v * weight;
        else if (v < 0) negative += -v * weight;
      }
      s = s.replace(new RegExp(`(?<![\\w-])${cue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g'), (m) => ' '.repeat(m.length));
    }
  });

  const ranked = [...categoryScore.entries()].sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  const category = top ? top[0] : null;

  let sentiment: Sentiment | null = null;
  let sentimentConfidence = 0;
  if (parts.length > 0) {
    const [[best, high], [, next]] = (
      [
        ['positive', positive],
        ['negative', negative],
        ['neutral', neutral],
      ] as [Sentiment, number][]
    ).sort((a, b) => b[1] - a[1]) as [[Sentiment, number], [Sentiment, number]];
    const total = positive + negative + neutral;
    // No cues, or a tie: a factual or even-handed text.
    sentiment = total === 0 || high === next ? 'neutral' : best;
    sentimentConfidence = total === 0 ? 0.5 : (high - next) / total;
  }
  const categoryConfidence = top ? (top[1] - (second?.[1] ?? 0)) / top[1] : 0;
  return { category, sentiment, confidence: round((categoryConfidence + sentimentConfidence) / 2) };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
