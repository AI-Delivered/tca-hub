#!/usr/bin/env node
// Unit tests for the denial judge. No network, no tokens, runs in milliseconds.
//
// Worth checking in because a gap in the judge is invisible in the worst way:
// find-denials.mjs prints "clean" and the clean run gets reported as evidence
// the app is healthy. Every case below where `want` is false is guarding
// against the opposite error — crying wolf on a correct answer.

import { judge } from './lib/denial-judge.mjs'

// `_` stands in for an apostrophe; each case runs with both the straight and
// the curly form, because model output uses both.
const CASES = [
  // --- real denials, drawn from wording the app has actually produced -------
  ['I don_t have information about when Titans for Christ meets.', [], 'DENIED'],
  ['I do not have that information.', [], 'DENIED'],
  ['I don_t have specific details about the club.', [], 'DENIED'],
  ['The meeting time is not listed in the available context.', [], 'DENIED'],
  ['Couldn_t find the sponsor.', [], 'DENIED'],
  ['That isn_t specified in the document.', [], 'DENIED'],
  ['TCA does not have a chess club.', [], 'DENIED'],
  ['There are no practices scheduled next week.', [], 'DENIED'],
  ['Cross country is not offered at the elementary level.', [], 'DENIED'],
  ['I_m unable to locate that teacher.', [], 'DENIED'],

  // --- correct answers that must NOT be flagged ----------------------------
  ['Titans for Christ meets Tuesdays at Lunch in Room 1118.', ['Room 1118'], 'ok'],
  ['The team does have practice on Tuesday at 3:30.', ['Tuesday'], 'ok'],
  // Hedging about something adjacent, while carrying the fact asked for.
  ['The room isn_t listed, but Speech and Debate meets Mondays.', ['Mondays'], 'ok'],
  ['Principal Erin Cook leads North Elementary.', ['Cook'], 'ok'],
  // Expected token absent and no denial language: wrong, but not a denial.
  ['The club is run by the science department.', ['Harris'], 'other'],

  // --- boundaries ----------------------------------------------------------
  ['', ['x'], 'empty'],
  ['   ', ['x'], 'empty'],
]

/* Existence mode, kept separate because its rule is inverted: the expect token
 * is the thing's own name, which a denial repeats back. The first real run of
 * find-denials.mjs scored exactly this shape as a pass and reported the run
 * clean while the app was denying a club that is in a school PDF. */
const EXISTENCE = [
  ['I don_t have information about a Titans for Christ club at TCA.', ['Titans'], 'DENIED'],
  ['TCA does not have a Titans for Christ club.', ['Titans'], 'DENIED'],
  ['Yes — Titans for Christ meets Tuesdays at Lunch in Room 1118.', ['Titans'], 'ok'],
  ['Yes, that club is active this year.', ['Titans'], 'ok'],
]

let failed = 0
for (const [tpl, expect, want] of EXISTENCE) {
  for (const ap of ["'", '\u2019']) {
    const answer = tpl.replaceAll('_', ap)
    const { verdict } = judge(answer, { expect, mode: 'existence' })
    if (verdict !== want) {
      failed++
      console.log(`FAIL  [existence] want ${want}, got ${verdict}\n      ${JSON.stringify(answer)}`)
    }
  }
}

for (const [tpl, expect, want] of CASES) {
  for (const ap of ["'", '’']) {
    const answer = tpl.replaceAll('_', ap)
    const { verdict } = judge(answer, { expect })
    if (verdict !== want) {
      failed++
      console.log(`FAIL  want ${want}, got ${verdict}\n      ${JSON.stringify(answer)}`)
    }
  }
}

const total = (CASES.length + EXISTENCE.length) * 2
console.log(failed ? `\n${failed}/${total} judge cases failed` : `${total} judge cases passed`)
process.exit(failed ? 1 : 0)
