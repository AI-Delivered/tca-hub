/* One pricing table, imported by everything that turns logged tokens into money.
 *
 * There were two, each carrying a comment saying it was kept in sync with the
 * other by hand. They drifted the moment a third model appeared: both chose a
 * rate with `model.includes('sonnet') ? sonnet : haiku`, so GPT-5.4 nano — a
 * fifth the price of Haiku on input — was reported at roughly five times what it
 * cost, on the dashboard total, on every per-query line, and in the "most
 * expensive" ranking that decides which queries are worth looking at. They had
 * also drifted on substance: the stats copy priced cache tokens, the per-query
 * copy silently ignored them, so the same query cost two different amounts
 * depending on which screen you read it from.
 *
 * A model with no entry here is priced as null rather than guessed at. Callers
 * report that as unpriced, which is a visible gap instead of a confident wrong
 * number — the failure mode that hid the nano bug in the first place.
 */

/** Published rates in USD per million tokens, keyed by the exact `model` string
 *  written to query_log. */
export const PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
  'claude-sonnet-5': { input: 3.0, output: 15.0 },
  'gpt-5.4-nano-2026-03-17': { input: 0.2, output: 1.25 },
}

/* Cache tokens bill at a multiple of the input rate: writing an entry costs
 * 1.25x, reading one costs 0.1x. Counting them as free understates every cached
 * request; `input_tokens` is only the uncached remainder once caching is on. */
export const CACHE_WRITE_MULTIPLIER = 1.25
export const CACHE_READ_MULTIPLIER = 0.1

export interface PricedRow {
  model?: string | null
  input_tokens?: number | null
  output_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

/** The rate for a logged model string, or null if there is no published price.
 *  The `-failed` suffix the search route writes on an errored generation is
 *  stripped first, so a partially-billed failure still prices correctly. */
export function priceFor(model: string | null | undefined) {
  if (!model) return null
  return PRICING[model.replace(/-failed$/, '')] ?? null
}

/** What one logged row cost, in USD. Null when the row predates token logging
 *  or names a model with no entry above — in both cases the honest answer is
 *  "unknown", not zero. */
export function costOfRow(row: PricedRow): number | null {
  if (row.input_tokens == null && row.output_tokens == null) return null
  const pricing = priceFor(row.model)
  if (!pricing) return null
  return (
    ((row.input_tokens ?? 0) / 1_000_000) * pricing.input +
    ((row.cache_creation_input_tokens ?? 0) / 1_000_000) * pricing.input * CACHE_WRITE_MULTIPLIER +
    ((row.cache_read_input_tokens ?? 0) / 1_000_000) * pricing.input * CACHE_READ_MULTIPLIER +
    ((row.output_tokens ?? 0) / 1_000_000) * pricing.output
  )
}
