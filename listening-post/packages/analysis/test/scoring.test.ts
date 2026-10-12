import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { computeMetrics, type EvalPair } from '../src/evaluate';
import { createClaudeClassifier } from '../src/llm';
import { scoreRules } from '../src/rules';

describe('scoreRules', () => {
  it.each([
    ['The support team at Pantrybox was rude and useless.', 'customer service', 'negative'],
    ['Delivery from Forkfold was faster than promised.', 'delivery', 'positive'],
    ['The price of Voltra Motors is about what I expected.', 'price', 'neutral'],
    ['The Mintora app is intuitive and quick.', 'usability', 'positive'],
    ['Heartlap has never let me down once over time.', 'reliability', 'positive'],
    ['The build quality of Pulseroo is honestly poor.', 'quality', 'negative'],
  ] as const)('%s', (text, category, sentiment) => {
    expect(scoreRules(text)).toMatchObject({ category, sentiment });
  });

  it('lets the opening sentence decide when later ones disagree', () => {
    const s = scoreRules('Shipping with Hopwell Air was on time, nothing special. The helpdesk at Hopwell Air was rude and useless.');
    expect(s).toMatchObject({ category: 'delivery', sentiment: 'neutral' });
  });

  it('flips a negated single word', () => {
    expect(scoreRules('The app is not good.').sentiment).toBe('negative');
  });

  it('labels nothing for empty text', () => {
    expect(scoreRules('')).toEqual({ category: null, sentiment: null, confidence: 0 });
  });
});

describe('computeMetrics', () => {
  const pair = (truth: [string, string], predicted: [string | null, string | null], site = 'chirp'): EvalPair =>
    ({ site, truth: { category: truth[0], sentiment: truth[1] }, predicted: { category: predicted[0], sentiment: predicted[1] } }) as EvalPair;

  it('computes accuracy, per-class F1 and counts unlabelled items as wrong', () => {
    const m = computeMetrics([
      pair(['price', 'positive'], ['price', 'positive']),
      pair(['price', 'negative'], ['delivery', 'negative']),
      pair(['delivery', 'neutral'], ['delivery', 'positive'], 'agora'),
      pair(['delivery', 'neutral'], [null, null], 'agora'),
    ]);
    expect(m.sampleSize).toBe(4);
    expect(m.categoryAccuracy).toBe(0.5);
    expect(m.sentimentAccuracy).toBe(0.5);
    // price: 1 TP, 0 FP, 1 FN; delivery: 1 TP, 1 FP, 1 FN.
    expect(m.detail.category.price).toEqual({ precision: 1, recall: 0.5, f1: 0.667, support: 2 });
    expect(m.detail.category.delivery).toEqual({ precision: 0.5, recall: 0.5, f1: 0.5, support: 2 });
    // Macro F1 averages only classes that occur in the sample.
    expect(m.detail.macroF1.category).toBe(0.584);
    expect(m.detail.sentimentConfusion.neutral).toEqual({ negative: 0, neutral: 0, positive: 1, none: 1 });
    expect(m.detail.bySite).toEqual({
      agora: { n: 2, categoryAccuracy: 0.5, sentimentAccuracy: 0 },
      chirp: { n: 2, categoryAccuracy: 0.5, sentimentAccuracy: 1 },
    });
  });
});

describe('createClaudeClassifier', () => {
  /** A real SDK client whose fetch answers with `reply` and records the request. */
  function fakeClient(reply: { status?: number; text?: string; stop_reason?: string }) {
    const requests: { headers: Headers; body: Record<string, unknown> }[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      requests.push({ headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      if (reply.status && reply.status !== 200) {
        return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), { status: reply.status });
      }
      return Response.json({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: reply.text ?? '' }],
        stop_reason: reply.stop_reason ?? 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 900, output_tokens: 120 },
      });
    }) as unknown as typeof globalThis.fetch;
    return { client: new Anthropic({ apiKey: 'test-key', fetch, maxRetries: 0 }), requests };
  }

  const batch = [
    { key: 'i0', text: 'The Mintora app is a joy to use.' },
    { key: 'i1', text: 'Delivery was late.' },
  ];

  it('sends one request with a JSON schema and fallbacks, and returns validated scores', async () => {
    const { client, requests } = fakeClient({
      text: JSON.stringify({
        results: [
          { id: 'i0', category: 'usability', sentiment: 'positive', confidence: 0.93 },
          { id: 'i1', category: 'delivery', sentiment: 'negative', confidence: 1.4 },
          { id: 'zz', category: 'price', sentiment: 'neutral', confidence: 0.5 },
        ],
      }),
    });
    const res = await createClaudeClassifier({ model: 'claude-opus-5-5', client }).classify(batch);
    expect([...res.scores]).toEqual([
      ['i0', { category: 'usability', sentiment: 'positive', confidence: 0.93 }],
      // Confidence is clamped to [0, 1]; unknown ids are dropped.
      ['i1', { category: 'delivery', sentiment: 'negative', confidence: 1 }],
    ]);
    expect(res).toMatchObject({ inputTokens: 900, outputTokens: 120, model: 'claude-opus-5-5' });

    const [req] = requests;
    expect(req!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(req!.body).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', output_config: { effort: 'low', format: { type: 'json_schema' } } });
    expect(JSON.stringify(req!.body.messages)).toContain('The Mintora app is a joy to use.');
  });

  it('answers nothing on a refusal or on output that fails the schema', async () => {
    const refused = fakeClient({ text: '', stop_reason: 'refusal' });
    expect((await createClaudeClassifier({ model: 'm', client: refused.client }).classify(batch)).scores.size).toBe(0);

    const garbled = fakeClient({ text: '{"results": [{"id": "i0", "category": "weather"' });
    const res = await createClaudeClassifier({ model: 'm', client: garbled.client }).classify(batch);
    expect(res).toMatchObject({ stopReason: 'invalid_output' });
    expect(res.scores.size).toBe(0);
  });

  it('lets API errors through, so the batch is retried later', async () => {
    const { client } = fakeClient({ status: 529 });
    await expect(createClaudeClassifier({ model: 'm', client }).classify(batch)).rejects.toBeInstanceOf(Anthropic.APIError);
  });
});
