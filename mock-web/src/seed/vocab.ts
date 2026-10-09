// All brand names and wording below are invented for this mock.
import type { Category, Sentiment, Topic } from './types.js';

/** Eight fictional companies per topic; also the {brand} slot values. */
export const BRANDS: Record<Topic, readonly string[]> = {
  'electric cars': [
    'Voltra Motors', 'Ampwick Auto', 'Silvane EV', 'Kestrel Drive',
    'Northcoil Cars', 'Brindle Electric', 'Zephyrine Motors', 'Ohmsted Auto',
  ],
  'budget airlines': [
    'SkyPenny Air', 'Lowcloud Airways', 'Fairwing', 'Jetsparrow',
    'Cirrusaver', 'Hopwell Air', 'Tailbreeze', 'Bluestep Airlines',
  ],
  'meal kits': [
    'Pantrybox', 'Forkfold', 'Simmerly', 'Crate & Ladle',
    'Hearthkit', 'Greenparcel', 'Spoonward', 'Dinnerloft',
  ],
  'fitness trackers': [
    'Pulseroo', 'Stridewell', 'Heartlap', 'Pacewren',
    'Vitaloop', 'Trekmark', 'Cadenza Fit', 'Moxie Band',
  ],
  'online banks': [
    'Coinharbor', 'Ledgerly', 'Brightvault', 'Pennyfox Bank',
    'Quillbank', 'Mintora', 'Hollow Oak Bank', 'Tallycap',
  ],
};

/** {detail} slot values, phrased to follow a noun. */
export const DETAILS: Record<Topic, readonly string[]> = {
  'electric cars': ['on the long-range model', 'after the latest software update', 'for the compact hatch', 'on a winter road trip'],
  'budget airlines': ['on my last trip', 'for a weekend return flight', 'on the early morning route', 'with checked luggage'],
  'meal kits': ['for the family box', 'on the vegetarian plan', 'in the first month', 'for a two-person order'],
  'fitness trackers': ['on the newest band', 'during marathon training', 'after a firmware update', 'with sleep tracking on'],
  'online banks': ['for the joint account', 'when moving abroad', 'on the premium plan', 'after switching from my old bank'],
};

// A template is SUBJECT + " " + PREDICATE + ".", giving 5 x 3 = 15 per category and sentiment (270 in total).
const SUBJECTS: Record<Category, readonly string[]> = {
  price: [
    'the price of {brand}', 'what {brand} charges {detail}', 'the monthly cost with {brand}',
    'pricing at {brand}', 'the fee I paid {brand} {detail}',
  ],
  quality: [
    'the build quality of {brand}', 'the overall quality at {brand}', 'what {brand} delivered {detail}',
    'the finish on everything from {brand}', 'quality from {brand} {detail}',
  ],
  'customer service': [
    'customer service at {brand}', 'the support team at {brand}', 'getting help from {brand} {detail}',
    'the helpdesk at {brand}', 'the agent I spoke to at {brand}',
  ],
  reliability: [
    'the reliability of {brand}', '{brand} {detail}', 'my experience with {brand} over time',
    'day-to-day dependability at {brand}', 'consistency at {brand}',
  ],
  usability: [
    'the {brand} app', 'using {brand} {detail}', 'setting up {brand}',
    'the interface {brand} offers', 'booking or changing anything with {brand}',
  ],
  delivery: [
    'delivery from {brand}', 'getting my order from {brand} {detail}', 'the delivery time at {brand}',
    'the handover with {brand}', 'shipping with {brand}',
  ],
};

const PREDICATES: Record<Category, Record<Sentiment, readonly string[]>> = {
  price: {
    negative: ['is a rip-off if you ask me', 'keeps going up for no good reason', 'felt far too high for what you get'],
    neutral: ['is about what I expected', 'is roughly in line with the competition', 'is neither cheap nor expensive'],
    positive: ['is genuinely good value', 'beat every other quote I got', 'felt very fair to me'],
  },
  quality: {
    negative: ['is honestly poor', 'fell apart much sooner than it should have', 'was a real letdown'],
    neutral: ['is average, nothing to report', 'is okay for the category', 'is pretty standard'],
    positive: ['is excellent', 'exceeded what I hoped for', 'feels really premium'],
  },
  'customer service': {
    negative: ['was rude and useless', 'took weeks to answer a simple question', 'kept passing me around without fixing anything'],
    neutral: ['answered within the usual time', 'was polite but scripted', 'did what was needed and no more'],
    positive: ['was friendly and sorted it in minutes', 'went above and beyond for me', 'was fantastic from start to finish'],
  },
  reliability: {
    negative: ['has been terrible, with constant problems', 'let me down more than once', 'is something I can no longer count on'],
    neutral: ['has been mostly fine with the odd hiccup', 'is acceptable, nothing more', 'has been about the same as anyone else'],
    positive: ['has been rock solid', 'never let me down once', 'is something I can always count on'],
  },
  usability: {
    negative: ['is confusing and clunky', 'made a simple task painful', 'is the worst I have used'],
    neutral: ['works, though it takes some getting used to', 'is fairly standard', 'is usable once you know where things are'],
    positive: ['is intuitive and quick', 'made everything effortless', 'is a joy to use'],
  },
  delivery: {
    negative: ['was late and badly handled', 'turned into a week of excuses', 'arrived damaged and nobody cared'],
    neutral: ['arrived within the stated window', 'was on time, nothing special', 'went as described'],
    positive: ['was early and perfectly handled', 'was faster than promised', 'was smooth from start to finish'],
  },
};

export type SentenceBank = Record<Category, Record<Sentiment, string[]>>;

export function buildBank(): SentenceBank {
  const bank = {} as SentenceBank;
  for (const [category, subjects] of Object.entries(SUBJECTS) as [Category, readonly string[]][]) {
    const bySentiment = {} as Record<Sentiment, string[]>;
    for (const [sentiment, predicates] of Object.entries(PREDICATES[category]) as [Sentiment, readonly string[]][]) {
      bySentiment[sentiment] = subjects.flatMap((s) => predicates.map((p) => `${s} ${p}.`));
    }
    bank[category] = bySentiment;
  }
  return bank;
}

export const CATEGORY_LABELS: Record<Category, string> = {
  price: 'pricing',
  quality: 'quality',
  'customer service': 'customer service',
  reliability: 'reliability',
  usability: 'app',
  delivery: 'delivery',
};

export const TITLES: Record<Sentiment, readonly string[]> = {
  negative: [
    '{brand} {label} is a joke', 'Really disappointed with {brand} {label}',
    'Avoid {brand} if you care about {label}', 'Anyone else had bad {label} from {brand}?',
  ],
  neutral: [
    'Thoughts on {brand} {label}?', '{brand} {label}: my experience so far',
    'Question about {brand} {label}', '{brand} {label} compared with others',
  ],
  positive: [
    '{brand} {label} is brilliant', 'Pleasantly surprised by {brand} {label}',
    'Shout-out to {brand} for great {label}', 'Very happy with {brand} {label}',
  ],
};

/** Appended to about 1% of items: emoji, literal HTML entities and non-Latin text. */
export const ODDITIES: readonly string[] = [
  '👀 &amp; Привіт усім, як справи?',
  '✈️😅 Grüße aus Köln, zażółć gęślą jaźń',
  '📦 &quot;edit&quot;: これはテストです',
  '💳🙂 &#8364; Γεια σας από την Αθήνα',
  '🏃‍♀️ &lt;3 مرحبا بالجميع',
  '🔋🤔 &nbsp;Ça dépend… 你好',
];

/** Neutral lines used in Agora blockquotes. */
export const QUOTES: readonly string[] = [
  'Has anyone compared this with last year?',
  'Posting this for anyone searching later.',
  'Quoting the original question for context.',
  'Same question came up in another thread.',
];
