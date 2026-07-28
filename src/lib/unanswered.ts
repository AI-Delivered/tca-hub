// Deciding whether the app actually answered a parent's question.
//
// This used to be `top_similarity < 0.6` — a retrieval score standing in for an
// answer's quality — and it was written out separately in the two admin routes.
// Measured against 823 logged rows it was wrong in both directions at once:
//
//   - 118 rows fell below the threshold and 107 of them were good answers. Half
//     of every confident answer in the log was labelled thin, which makes the
//     signal something you learn to ignore.
//   - 29 answers say outright that the information isn't there — "I don't have
//     the football coach's name in the available data". Nine of those scored
//     0.90, because an athletics keyword anchor had fired and stamped that
//     constant on, so they were counted as answered. The one status that should
//     be impossible to miss was the one it missed.
//
// The two numbers disagree because they measure different things: the anchor
// did find a confidently relevant chunk, and the chunk still had no coach's
// name in it. What the parent was told is recorded in the answer, so that is
// what these read.
//
// Patterns are written once as ILIKE — so a PostgREST filter can use them
// directly — and compiled to a regex for in-process checks. One definition, so
// a dashboard chip's count and the list behind it cannot drift apart.

export const UNANSWERED_ILIKE = [
  '%don%t have%',
  '%do not have%',
  '%don%t currently have%',
  '%don%t see%',
  '%do not see%',
  '%couldn%t find%',
  '%could not find%',
  '%unable to find%',
  '%isn%t in the%',
  '%is not in the%',
  '%not listed%',
  '%no information%',

  /* The second half of this list came from checking the first half against the
   * answers actually being written, rather than from imagining how a model
   * declines. It turns out it declines in more than one voice.
   *
   * "The 2026-27 playoff dates haven't been posted", "the High School track
   * schedule hasn't been posted yet", "practice dates aren't listed in the
   * upcoming schedule" — all plainly saying the information is not there, none
   * of them matched. Measured over 454 answered rows, the original twelve
   * patterns caught 38 and missed 22 more, so roughly a third of the app's real
   * gaps were invisible on the dashboard that exists to show them.
   *
   * Note "aren't listed" against "not listed": ILIKE's % stands in for the
   * apostrophe but not for a different word, so the negation twins have to be
   * written out. The uncontracted forms are here for symmetry — they had no
   * hits yet and cost nothing.
   */
  '%aren%t listed%',
  '%isn%t listed%',
  '%haven%t been posted%',
  '%hasn%t been posted%',
  '%have not been posted%',
  '%has not been posted%',
  '%doesn%t include%',
  '%does not include%',
] as const

// `%` stands in for the apostrophe as well as for arbitrary text, so each
// pattern covers "don't", "dont" and "do not" spellings without a separate
// entry per contraction.
export const UNANSWERED_RE = new RegExp(
  UNANSWERED_ILIKE.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')).join('|'),
  'i'
)

/** A PostgREST `or=` argument matching any of the patterns against a column. */
export function unansweredOrFilter(column = 'answer_preview'): string {
  return UNANSWERED_ILIKE.map(p => `${column}.ilike.${p}`).join(',')
}

/** Did this answer tell the parent we don't have the information? */
export function saidItCouldNotAnswer(answer: string | null | undefined): boolean {
  return UNANSWERED_RE.test(answer ?? '')
}
