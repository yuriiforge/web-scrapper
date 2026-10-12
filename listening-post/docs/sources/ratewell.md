# Ratewell (review site behind bot protection)

**Strategy: an escalation ladder**, starting at `html` and climbing only when blocked: `html` → `browser` → `unblocker`. Collector: [`packages/collectors/src/ratewell`](../../packages/collectors/src/ratewell).

## What makes it hard

- The company page is an empty shell. Reviews load in the browser from `/_data/company/:slug/reviews`, and that endpoint only answers with a valid `X-RW-Nonce` and `X-RW-Token`.
- Bot checks (mock-web's `botCheckLevel`):
  - level 1 blocks a missing `Accept-Language` or a tool-like user agent (`curl`, `python`, `HeadlessChrome`…);
  - level 2 also blocks sessions whose browser reports `navigator.webdriver`;
  - level 3 blocks everything that doesn't come through PassGate.
- More than 30 data requests a minute in one session gets that session blocked for 5 minutes.

## The ladder

| Step | How | Cost | Gets past |
| --- | --- | --- | --- |
| `html` | Plain HTTP. Load the page for the `rw_sid` cookie and the nonce, then compute the token in Node exactly as `app.js` does: FNV-1a of `nonce:rw_sid`. Realistic browser headers. | Free | Levels 0–2 |
| `browser` | Playwright Chromium with a normal Chrome user agent and language, and `navigator.webdriver` hidden. The page runs its own script; the collector captures the JSON it fetches and clicks "Load more". | About $0.01 per browser-minute | Levels 0–2 |
| `unblocker` | PassGate fetches the data JSON on our behalf (1 credit a page). If that fails, it asks for a rendered page instead (5 credits) and parses the HTML. | $0.002 a credit | Every level |

On a block (`403` with `X-RW-Block`), the collector closes the current step, moves up one step and retries the same page. The checkpoint remembers the step that worked, so the next run starts there. After a day on a costlier step, it tries one step lower again, so a lifted block stops costing money. A source can forbid steps: `strategies: ["html", "browser"]` never pays PassGate and fails as `blocked` instead.

## Why plain HTTP first

Reimplementing the token is about 10 lines and makes the browser unnecessary for this site at levels 0–2. A browser costs compute and is slower, and an unblocker costs money per page. The browser step still matters, because real sites often hide their token logic in obfuscated, frequently changing scripts. When that happens, running the site's own script is cheaper to maintain than reimplementing it.

## Costs and budgets

- **Browser time** is charged when the browser closes, in browser-minutes.
- **PassGate credits** are charged per response, from `X-PassGate-Credits-Charged`. A 5xx from the target is not charged, matching PassGate's own rule.
- **Budget check.** Before every paid request, the collector checks the source's monthly budget. If it would be exceeded, the run stops as `partial` (`quota`) and keeps what it saved. A 402 from PassGate (out of credits) ends the run the same way.
- **Reconciliation.** The integration tests check that the ledger's PassGate credits equal PassGate's own `credits_used`.

## Incremental runs

Reviews come newest first. The checkpoint stores the newest `created_at` seen, and the next run stops at the first page that reaches it. A rerun with nothing new costs one page: one request, or one credit on the unblocker.

## What breaks it

| Change on the site | What happens |
| --- | --- |
| Layout version 2 (`reviews` renamed `items`, rating as a string) | `parse` error; the response is kept |
| The nonce or cookie disappears from the page | `parse` error on the `html` step ("the page changed") |
| Token rejected (nonce older than 10 minutes) | A new session, once |
| PassGate out of credits / budget reached | `partial`, with the items saved so far |
| Bot check level raised mid-run | Escalates mid-run and continues from the same page |

## A note on real sites

This is practice against a fake site. On a real one, check the terms of service and robots.txt first. Prefer an official API or a licensed dataset. Treat getting past bot protection as a decision for the client, with legal input, and record that decision in this file.
