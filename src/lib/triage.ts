/* Working out what a reported bug amounts to, without a person reading it first.
 *
 * A parent pressing "this was wrong" is the only signal in this app that comes
 * from a human, and the only one that can see a confident incorrect answer —
 * nothing else here can. Those reports have been landing in query_feedback and
 * sitting there. So has the app's own admission of failure: an answer that says
 * "I don't have the football coach's name" is a reported bug the app filed against
 * itself, and there are hundreds of them in query_log.
 *
 * Most of that backlog needs no judgement to process. Asked the same question
 * again, the app either still trips a check that can be evaluated in code, or it
 * does not — and either way that is worth knowing before anybody reads a word of
 * it. What is left after this runs is the set of reports that genuinely need a
 * human, which is a much shorter list than the set that arrived.
 *
 * The verdicts are deliberately careful about what code can and cannot settle:
 *
 *   A "wrong date" report is only closed when the fault is one arithmetic can
 *   see. Nothing here knows the school's calendar, so an answer that is merely
 *   *different* now is reported as changed, not as fixed. Calling it fixed would
 *   be the same overreach that produced the original bug.
 *
 *   A "no answer" report is closed when the app answers, because that one is
 *   fully checkable: the corpus either has it now or it does not.
 */

import { checkAnswerDates, datesNamedIn } from './schedule.ts'
import { saidItCouldNotAnswer } from './unanswered.ts'

export type Verdict =
  /** The fault the report describes no longer happens, and that is checkable. */
  | 'resolved'
  /** A day name still disagrees with its date — the output check is not reached. */
  | 'day-date-contradiction'
  /** The answer rests on a date that appears in no chunk. */
  | 'unsupported-date'
  /** Two runs of one question named different dates. */
  | 'unstable'
  /** The app still says it does not have this. */
  | 'no-answer'
  /** Nothing checkable is wrong, and the answer has changed since the report. */
  | 'changed-needs-eyes'
  /** Nothing checkable is wrong, and the answer is the same one that was reported. */
  | 'reproduces-needs-calendar'
  /** The app could not be asked — rate limited, or an error. */
  | 'not-evaluated'

export interface ReportedBug {
  /** 'wrong' | 'incomplete' | 'no-answer' | 'other', or 'self' for the app's own admission. */
  reason: string
  query: string
  /** What the parent was looking at when they reported it, where we have it. */
  answer?: string | null
}

export interface Triage {
  verdict: Verdict
  /** One line a human can act on. */
  detail: string
  /** Whether this needs a person now. */
  needsHuman: boolean
  /** Safe, reversible things the triage route should do about it. */
  actions: Array<'expire-cached-answer'>
}

/** Are two answers making the same dated claims? */
function sameDates(a: string, b: string, today: string): boolean {
  return datesNamedIn(a, today).join() === datesNamedIn(b, today).join()
}

export function triageBug(input: {
  bug: ReportedBug
  /** The same question asked again, twice, with the answer cache bypassed. */
  freshAnswers: string[]
  /** Every date the corpus contains, for deciding whether an answer read or invented one. */
  corpusDates: Set<string>
  today: string
}): Triage {
  const { bug, freshAnswers, corpusDates, today } = input
  const usable = freshAnswers.filter(a => a && a.trim())

  if (!usable.length) {
    return {
      verdict: 'not-evaluated',
      detail: 'the app could not be asked — rate limited or erroring; this report is untouched',
      needsHuman: false,
      actions: [],
    }
  }

  /* A day name that contradicts its own date, after the output check shipped.
   *
   * This is not supposed to be reachable: the stream guard resolves every pair on
   * the way out. Finding one means the deployed build does not have it or this
   * path does not stream through it, which is a deployment fact worth more than
   * the individual report. */
  for (const answer of usable) {
    const { corrected, unsupported } = checkAnswerDates(answer, { today, contextDates: new Set() })
    const bad = [...corrected, ...unsupported][0]
    if (bad) {
      return {
        verdict: 'day-date-contradiction',
        detail: `still answers "${bad.was}", which is not that day — the output check is not running on this path`,
        needsHuman: true,
        actions: ['expire-cached-answer'],
      }
    }
  }

  // A date the corpus does not contain: either a source is missing or the model
  // produced the date rather than reading it. Both need a person, and neither
  // should be served from cache in the meantime.
  const invented = usable
    .flatMap(a => datesNamedIn(a, today))
    .find(ymd => !corpusDates.has(ymd))
  if (invented) {
    return {
      verdict: 'unsupported-date',
      detail: `answers with ${invented}, which appears in no chunk — a missing source, or a date produced rather than read`,
      needsHuman: true,
      actions: ['expire-cached-answer'],
    }
  }

  /* Two runs, two different dates. The failure a single sample cannot see, and
   * the one a parent describes as "it told me something different yesterday". */
  if (usable.length > 1 && !usable.every(a => sameDates(a, usable[0], today))) {
    return {
      verdict: 'unstable',
      detail: `two runs named different dates: ${usable.map(a => datesNamedIn(a, today).join('/') || '(none)').join(' vs ')}`,
      needsHuman: true,
      actions: ['expire-cached-answer'],
    }
  }

  const stillSilent = usable.every(saidItCouldNotAnswer)
  const reportedSilence = bug.reason === 'no-answer' || saidItCouldNotAnswer(bug.answer)

  if (stillSilent) {
    return {
      verdict: 'no-answer',
      detail: 'the app still says it does not have this — the corpus is missing the source, not misreading it',
      needsHuman: true,
      actions: [],
    }
  }

  // The app was silent when this was reported and answers now: fully checkable,
  // and closed without anyone reading it.
  if (reportedSilence) {
    return {
      verdict: 'resolved',
      detail: 'the app answers this now, where the report says it did not',
      needsHuman: false,
      actions: [],
    }
  }

  /* Everything checkable passes, and the report said the answer was wrong.
   *
   * This is where code stops. Whether "Friday, August 28" is the day the school
   * published is a fact about the school's calendar, and nothing in this process
   * has it — the honest outcome is to say what changed and hand it over, not to
   * call it fixed because it no longer trips a regex. */
  if (bug.answer && !sameDates(bug.answer, usable[0], today)) {
    return {
      verdict: 'changed-needs-eyes',
      detail: `the dated claim changed since the report (${datesNamedIn(bug.answer, today).join('/') || 'none'} ` +
        `→ ${datesNamedIn(usable[0], today).join('/') || 'none'}) and nothing checkable is wrong now`,
      needsHuman: true,
      actions: [],
    }
  }

  return {
    verdict: 'reproduces-needs-calendar',
    detail: 'the app still gives the reported answer and nothing checkable is wrong — ' +
      'only the school\'s own calendar can settle this one',
    needsHuman: true,
    actions: [],
  }
}

export interface TriageSummary {
  evaluated: number
  resolved: number
  needHuman: number
  byVerdict: Record<string, number>
}

export function summarise(results: Array<{ verdict: Verdict; needsHuman: boolean }>): TriageSummary {
  const byVerdict: Record<string, number> = {}
  for (const r of results) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1
  return {
    evaluated: results.filter(r => r.verdict !== 'not-evaluated').length,
    resolved: results.filter(r => r.verdict === 'resolved').length,
    needHuman: results.filter(r => r.needsHuman).length,
    byVerdict,
  }
}
