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

/* The numbers themselves live in model-rates.json, not here, because
 * scripts/lib/ask.mjs needs them too and cannot import TypeScript. JSON is the
 * one format both sides read without a build step, so there is exactly one
 * place to edit when a rate changes or a model is added.
 *
 * Note on Sonnet 5: listed at its standard 3.00/15.00. It is on an introductory
 * 2.00/10.00 through 2026-08-31, so totals currently overstate Sonnet slightly
 * and become exact when the intro rate lapses. Deliberately not date-switched —
 * pricing historical rows correctly would mean keying off each row's timestamp,
 * which is worth doing only if the intro period is ever extended. */
import rates from './model-rates.json'

/** Published rates in USD per million tokens, keyed by the exact `model` string
 *  written to query_log. */
export const PRICING: Record<string, { input: number; output: number }> = rates.models

/* Cache tokens bill at a multiple of the input rate: writing an entry costs
 * 1.25x, reading one costs 0.1x. Counting them as free understates every cached
 * request; `input_tokens` is only the uncached remainder once caching is on. */
export const CACHE_WRITE_MULTIPLIER = rates.cacheWriteMultiplier
export const CACHE_READ_MULTIPLIER = rates.cacheReadMultiplier

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
