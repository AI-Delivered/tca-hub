/* One pricing table, imported by everything that turns logged tokens into money.
 *
 * There were three, each carrying a comment saying it was kept in sync with the
 * others by hand. They drifted the moment a third model appeared: all of them
 * chose a rate with `model.includes('sonnet') ? sonnet : haiku`, so GPT-5.4 nano
 * — a fifth the price of Haiku on input — was reported at roughly five times
 * what it cost, on the dashboard total, on every per-query line, and in the
 * "most expensive" ranking that decides which queries are worth looking at. They
 * had drifted on substance too: one priced cache tokens, one ignored them, and
 * the test harness priced Sonnet at a different rate than the app did.
 *
 * A model with no entry here prices as null rather than being guessed at.
 * Callers report that as unpriced, which is a visible gap instead of a confident
 * wrong number — the failure mode that hid the nano bug in the first place.
 *
 * The numbers live in model-rates.json, not here, because scripts/lib/ask.mjs
 * needs them too and cannot import TypeScript. JSON is the one format both sides
 * read without a build step.
 */
import rates from './model-rates.json'

export interface RatePeriod {
  /** Inclusive ISO date this rate took effect. */
  from: string
  /** USD per million tokens. */
  input: number
  output: number
}

/** Rate history per model, keyed by the exact `model` string written to
 *  query_log, oldest period first. */
export const PRICING = rates.models as Record<string, RatePeriod[]>

/* Cache tokens bill at a multiple of the input rate: writing an entry costs
 * 1.25x, reading one costs 0.1x. Counting them as free understates every cached
 * request; `input_tokens` is only the uncached remainder once caching is on. */
export const CACHE_WRITE_MULTIPLIER = rates.cacheWriteMultiplier
export const CACHE_READ_MULTIPLIER = rates.cacheReadMultiplier

export interface PricedRow {
  model?: string | null
  created_at?: string | null
  input_tokens?: number | null
  output_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

/* Rates are a history rather than a single number because Sonnet 5 shipped on an
 * introductory 2.00/10.00 through 2026-08-31 and reverts to 3.00/15.00 after.
 * A single figure is wrong on one side of that date whichever value you pick,
 * and the flip would land silently — a 33% error nobody would be looking for. So
 * each row prices at the rate in force when it was logged, which keeps historical
 * totals stable instead of rewriting last month's spend every time a price moves.
 *
 * Rows with no timestamp fall back to the newest period: an un-dated row is
 * almost always one being priced as it happens. */
export function priceFor(
  model: string | null | undefined,
  at?: string | null,
): RatePeriod | null {
  if (!model) return null
  // '-failed' rows log no tokens, but strip the suffix anyway so a partially
  // billed failure prices correctly instead of falling through as unknown.
  const periods = PRICING[model.replace(/-failed$/, '')]
  if (!periods?.length) return null
  if (!at) return periods[periods.length - 1]
  let chosen = periods[0]
  for (const p of periods) if (p.from <= at) chosen = p
  return chosen
}

/** What one logged row cost, in USD. Null when the row predates token logging
 *  or names a model with no published price — in both cases the honest answer
 *  is "unknown", not zero. */
export function costOfRow(row: PricedRow): number | null {
  if (row.input_tokens == null && row.output_tokens == null) return null
  const rate = priceFor(row.model, row.created_at)
  if (!rate) return null
  return (
    ((row.input_tokens ?? 0) / 1_000_000) * rate.input +
    ((row.cache_creation_input_tokens ?? 0) / 1_000_000) * rate.input * CACHE_WRITE_MULTIPLIER +
    ((row.cache_read_input_tokens ?? 0) / 1_000_000) * rate.input * CACHE_READ_MULTIPLIER +
    ((row.output_tokens ?? 0) / 1_000_000) * rate.output
  )
}
