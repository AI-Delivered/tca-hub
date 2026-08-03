// Deciding whether an answer denied something the corpus actually contains.
//
// This lives apart from find-denials.mjs so it can be unit-tested without
// touching the network. It is the component whose own failure is least visible:
// when the judge misses a denial, the run prints "clean" and the clean run is
// then read as proof that nothing is wrong. Its first version did exactly that.

export const RATE_LIMITED = '__RATE_LIMITED__'

/* Apostrophes: model output carries the curly ’ at least as often as the
 * straight ', and a pattern that knows only one of them silently scores half
 * the denials as clean. Used everywhere below rather than a bare '?. */
const AP = "['’]?"

/** Denies the thing exists at all — the severe failure. */
export const NONEXISTENCE = new RegExp(
  `\\b(?:does(?:n${AP}t| not) (?:have|offer|appear to (?:have|offer))` +
  `|do(?:es)? not currently (?:have|offer)` +
  `|is not (?:offered|a (?:club|program|team|sport))` +
  `|are not offered|there (?:is|are) no\\b|there${AP}s no\\b|no such\\b|not offered at)`, 'i')

/* Says it cannot find the detail. This only counts as a failure because every
 * question is generated from a fact that is in the corpus.
 *
 * The "don't have information" branch exists because the first real run without
 * it scored a genuine denial as merely "other" and exited 0. The app's actual
 * words were "I don't have information about when Titans for Christ meets" —
 * the plainest possible phrasing — and the pattern covered only "I don't have
 * *that* information". */
export const MISSING = new RegExp(
  `\\b(?:not (?:listed|specified|available|provided|included|mentioned|named)` +
  `|isn${AP}t (?:listed|specified|available|provided|included)` +
  `|no (?:information|details|mention|record|listing)` +
  `|couldn${AP}t find|could not find|unable to (?:find|locate)` +
  `|do(?:n${AP}t| not) have (?:(?:that|this|the|any|specific|enough)\\s+)*(?:information|details|specifics|record|listing)` +
  `|not (?:in|found in) the (?:available |provided )?(?:context|information|documents))`, 'i')

/**
 * @param answer  what the app said
 * @param fact    {expect: string[], mode?: 'existence'} — any expect match counts
 * @returns {verdict: 'ok'|'DENIED'|'other'|'empty'|'rate-limited', severity?}
 */
export function judge(answer, fact) {
  if (answer === RATE_LIMITED) return { verdict: 'rate-limited' }
  if (!answer || !answer.trim()) return { verdict: 'empty' }
  const lower = answer.toLowerCase()

  const denial = NONEXISTENCE.test(answer) ? 'denies it exists'
    : MISSING.test(answer) ? 'says the detail is unavailable'
      : null

  /* For "does TCA have a <thing>?" the expect token is the thing's own name,
   * and a denial almost always repeats it — "I don't have information about a
   * Titans for Christ club". Scoring that as a pass is how the first run of
   * this tool reported a real failure as clean. So in existence mode the
   * denial patterns decide, and echoing the name proves nothing. */
  if (fact.mode === 'existence') {
    return denial ? { verdict: 'DENIED', severity: denial } : { verdict: 'ok' }
  }

  /* Otherwise carrying the fact wins outright, checked before the denial
   * patterns: a correct answer often hedges about something adjacent — "the
   * room isn't listed, but they meet Wednesdays" — and that is not a failure. */
  if ((fact.expect ?? []).some(e => e && lower.includes(String(e).toLowerCase()))) return { verdict: 'ok' }

  if (denial) return { verdict: 'DENIED', severity: denial }
  return { verdict: 'other', severity: 'answered without the expected detail' }
}
