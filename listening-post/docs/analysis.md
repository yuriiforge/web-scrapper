# Analysis: scoring, copies and evaluation

Every item gets a **category** (price, quality, customer service, reliability, usability, delivery) and a **sentiment** (negative, neutral, positive). Code: [`packages/analysis`](../packages/analysis). The worker runs one pass a minute.

## Two scorers

| Scorer | Runs on | Cost | Strength | Weakness |
| --- | --- | --- | --- | --- |
| **Rules** (`rules-v1`) | Every item | Free; the first pass labelled all 15,116 items | Instant; works with no key; a baseline to beat | Only knows the words in its lists |
| **Claude** (`LLM_MODEL`) | Originals, newest first, when `ANTHROPIC_API_KEY` is set | Tokens, booked in the cost ledger | Reads wording it has never seen, sarcasm and other languages | Costs money; can decline or return nothing |

Both write to `item_scores`, one row per item and method, so the two can be compared on the same items. Reports use Claude's label when an item has one and the rules label otherwise.

### Rules

- **Category:** a list of cue words and phrases per category (for example "fee", "refund", "the app", "parcel"); the category with the most cues wins.
- **Sentiment:** weighted cues for positive and negative, plus explicit neutral wording ("about average", "as described", "on time"). A neutral review usually has no strong words, so without neutral cues one later emotional sentence would outvote it. A negator ("not", "never") just before a single cue word flips it.
- **Order:** each sentence weighs half as much as the one before, because reviews lead with their point.
- **Confidence:** how far the winner is ahead of the runner-up.

The word lists were tuned while looking at mock-web's corpus, which is generated from templates. So the rules' accuracy here (about 96% category, 98% sentiment) is a ceiling, not a forecast for real text. That is the reason to keep a model scorer and to check both against ground truth.

### Claude

- **Batches:** 25 items per request (`LLM_BATCH_SIZE`), each with a short id (`i0`, `i1`, …), so both the prompt and the answer stay small. Each text is capped at 4,000 characters, far above any review in the corpus.
- **Output:** structured output against a Zod schema (`{ results: [{ id, category, sentiment, confidence }] }`), parsed and validated by the SDK. Unknown ids are dropped and confidence is clamped to 0–1.
- **Effort `low`:** labelling needs little reasoning, and this keeps thinking tokens (which are billed) small.
- **Refusals:** server-side fallback (`fallbacks: "default"`) lets the API retry on another model in the same call if a safety classifier declines.
- **Failures:**
  - Unanswered items (a refusal after fallback, or output that fails the schema) get an empty model row. They are not paid for twice, and the rules label stands in.
  - API errors (rate limits, outages) write nothing and stop the pass; the batch goes again on the next pass.
- **Spend:** tokens × the `LLM_*_USD_PER_MTOK` prices, booked under provider `anthropic`, split between clients by their share of the batch.
  - It has no source, so it does not eat into a source's collection budget (a Chirp source's $2 would otherwise go on scoring).
  - `LLM_MONTHLY_USD` (default $5) caps it across all clients; the pass stops when the cap is reached.
  - `LLM_MAX_ITEMS_PER_PASS` (default 100 a minute) limits how fast a backlog is spent.

For a large backlog, the Message Batches API would halve the price at the cost of up to a day's delay. It isn't used here, so new items get labels within minutes.

## Copies

mock-web copies about 2% of comments, forum replies and Chirp posts word for word onto another site. Items whose normalised text (tags stripped, entities decoded, whitespace collapsed, lower-cased) has the same SHA-256 point at the first one collected, through `duplicate_of`.

- **Short texts don't count.** Texts under 40 characters ("Thanks, same here!") repeat by chance, so they are never marked.
- **Copies are never sent to the model;** they take their original's labels. This is where copies save money.
- **Reports count each text once.** The sentiment grid leaves copies out.
- **Deletions are handled.** When an original is deleted (with its source), the oldest remaining copy becomes the original on the next pass.

On the current data, 488 items are copies and 150 of those cross sites. The rest repeat a templated sentence on the same site.

## Evaluation

mock-web knows the true category and sentiment of everything it generated (`GET /_admin/truth?ids=…`, at most 500 ids per call). **Evaluate** on the Insights page, or `POST /api/analysis/evaluations`, does three things:

1. Takes a random sample (default 500) of items labelled by one method.
2. Fetches their true labels; items mock-web doesn't know are left out.
3. Stores the result in `eval_results`:
   - accuracy for category and sentiment;
   - precision, recall, F1 and support per class;
   - macro F1;
   - a sentiment confusion matrix;
   - accuracy per site.

An item with no label counts as wrong.

| Rules, 2,000 items (12 Oct 2026) | Category | Sentiment |
| --- | --- | --- |
| Accuracy | 96.6% | 99.0% |
| Macro F1 | 0.97 | 0.99 |

The Claude row fills in once the worker has a key and has labelled some items.
