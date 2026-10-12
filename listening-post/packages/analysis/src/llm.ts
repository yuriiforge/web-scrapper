import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { CATEGORIES, SENTIMENTS } from '@lp/shared';
import { z } from 'zod';
import type { Score } from './rules';

/** What the model must return: one entry per input item, keyed by the short id it was sent with. */
export const LlmOutput = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      category: z.enum(CATEGORIES),
      sentiment: z.enum(SENTIMENTS),
      confidence: z.number(),
    }),
  ),
});

export interface ClassifyInput {
  /** Short id, unique within the batch; keeps the prompt and the answer small. */
  key: string;
  text: string;
}

export interface ClassifyResult {
  /** Scores by input key. Missing keys were not answered (refusal, cut-off output, bad JSON). */
  scores: Map<string, Score>;
  inputTokens: number;
  outputTokens: number;
  /** The model that answered; differs from the requested one when a fallback ran. */
  model: string;
  stopReason: string | null;
}

export interface Classifier {
  readonly model: string;
  classify(batch: ClassifyInput[]): Promise<ClassifyResult>;
}

/** Longest text sent per item. Reviews and posts are far shorter; this only stops a pasted essay. */
export const MAX_ITEM_CHARS = 4000;

const SYSTEM = `You label customer feedback collected from forums, review sites and social posts.

For each item, choose:
- category: the single aspect the author mainly talks about.
  price = cost, fees, value for money.
  quality = how well made or how good the product itself is.
  customer service = support staff, helpdesk, how complaints are handled.
  reliability = whether it keeps working over time, outages, breakdowns.
  usability = apps, websites, interfaces, setting up or booking.
  delivery = shipping, orders arriving, handovers, delays in getting the product.
- sentiment: the author's overall feeling about that aspect: negative, neutral or positive.
  Neutral means factual or mixed with no clear lean.
- confidence: your confidence in both labels together, from 0 to 1.

When an item touches several aspects, pick the one its opening is about. Text in other languages, emoji
or stray markup does not change the labels. Return exactly one result per item, using the item's id.`;

/** Claude as a classifier: batches of items in, one validated JSON object out. */
export function createClaudeClassifier(opts: { model: string; client?: Anthropic; maxTokens?: number }): Classifier {
  // Resolves the API key from ANTHROPIC_API_KEY (or another configured credential) when no client is passed.
  const client = opts.client ?? new Anthropic();
  return {
    model: opts.model,
    async classify(batch) {
      const payload = batch.map((b) => ({ id: b.key, text: b.text.slice(0, MAX_ITEM_CHARS) }));
      const request = client.beta.messages.parse({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 16_000,
        // A short labelling task: low effort keeps thinking (and its cost) small.
        output_config: { effort: 'low', format: betaZodOutputFormat(LlmOutput) },
        // If a safety classifier declines, the API retries on a fallback model inside the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM,
        messages: [{ role: 'user', content: `Label these ${payload.length} items:\n${JSON.stringify(payload)}` }],
      });
      let response: Awaited<typeof request>;
      try {
        response = await request;
      } catch (err) {
        // API errors (rate limits, outages) propagate, so the batch is tried again on the next pass.
        // Any other SDK error here is output that failed validation, e.g. JSON cut off at max_tokens.
        if (err instanceof Anthropic.APIError || !(err instanceof Anthropic.AnthropicError)) throw err;
        return { scores: new Map(), inputTokens: 0, outputTokens: 0, model: opts.model, stopReason: 'invalid_output' };
      }
      const scores = new Map<string, Score>();
      const keys = new Set(batch.map((b) => b.key));
      if (response.stop_reason !== 'refusal') {
        for (const r of response.parsed_output?.results ?? []) {
          if (!keys.has(r.id)) continue;
          scores.set(r.id, { category: r.category, sentiment: r.sentiment, confidence: clamp01(r.confidence) });
        }
      }
      return {
        scores,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        model: response.model,
        stopReason: response.stop_reason,
      };
    },
  };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, Math.round(n * 1000) / 1000)) : 0;
}
