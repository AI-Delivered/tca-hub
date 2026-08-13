// Proof that a reported bug is closed only when code can actually settle it.
//
// Run with: node scripts/test-triage.mjs
//
// The temptation in an automatic triage is to mark things fixed. A "wrong date"
// report where nothing trips a regex any more is not fixed — nothing in this
// process knows the school's calendar, and calling that resolved is the same
// overreach that produced the original bug. So the interesting assertions here are
// the ones about what triage refuses to close.

import { triageBug, summarise } from '../src/lib/triage.ts'
import { answerCacheKey, CACHE_VERSION } from '../src/lib/query-key.ts'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`}`)
}
const checkTrue = (name, actual) => check(name, actual, true)

const TODAY = '2026-08-11'
// A gap that has been filled means the corpus now holds the source — so the date
// the answer gives is in here. 2026-08-18 is the newsletter's Meet and Greet.
const CORPUS = new Set(['2026-08-18', '2026-08-20', '2026-08-28', '2026-09-01', '2026-10-07'])
const triage = (bug, freshAnswers, corpusDates = CORPUS) =>
  triageBug({ bug, freshAnswers, corpusDates, today: TODAY })

console.log('\n— faults code can settle —\n')

/* The output check makes this unreachable, so finding one is a deployment fact
 * rather than a fact about the question. */
const contradiction = triage(
  { reason: 'wrong', query: 'when is jh picture day', answer: 'Thursday, August 28, 2026.' },
  ['JH Picture Day is Thursday, August 28, 2026 at 8:00 AM.', 'JH Picture Day is Thursday, August 28, 2026.']
)
check('a day/date contradiction is named as one', contradiction.verdict, 'day-date-contradiction')
checkTrue('and blamed on the path, not the question', contradiction.detail.includes('output check is not running'))
check('the cached answer is pulled', contradiction.actions, ['expire-cached-answer'])
checkTrue('a person is told', contradiction.needsHuman)

const invented = triage(
  { reason: 'wrong', query: 'when is picture day', answer: null },
  ['Picture Day is Friday, September 4, 2026.', 'Picture Day is Friday, September 4, 2026.']
)
check('a date in no chunk', invented.verdict, 'unsupported-date')
check('and it is pulled from cache too', invented.actions, ['expire-cached-answer'])

const unstable = triage(
  { reason: 'wrong', query: 'when is the next volleyball game', answer: null },
  ['The next game is Thursday, August 20 at 6:00 PM.', 'The next game is Tuesday, September 1 at 6:00 PM.']
)
check('two runs, two dates', unstable.verdict, 'unstable')
checkTrue('the detail shows both', unstable.detail.includes('2026-08-20') && unstable.detail.includes('2026-09-01'))

console.log('\n— gaps, which are checkable in both directions —\n')

const stillSilent = triage(
  { reason: 'no-answer', query: 'who is the golf coach', answer: "I don't have that information." },
  ["I don't have the golf coach in the available data.", "I don't see a golf coach listed."]
)
check('the app still has nothing', stillSilent.verdict, 'no-answer')
checkTrue('and it is called a missing source, not a misreading',
  stillSilent.detail.includes('missing the source'))
check('nothing is cached to pull', stillSilent.actions, [])

/* The one verdict that closes a report on its own. The corpus either has it now
 * or it does not, and that needs no calendar to decide. */
const nowAnswers = triage(
  { reason: 'no-answer', query: 'when is the meet and greet', answer: "I couldn't find information about that." },
  ['The East Elementary Meet and Greet is Tuesday, August 18 at 5:00 PM.',
   'The East Elementary Meet and Greet is Tuesday, August 18 at 5:00 PM.']
)
check('a gap that has since been filled is resolved', nowAnswers.verdict, 'resolved')
check('and needs nobody', nowAnswers.needsHuman, false)

/* Precedence, which matters more than it looks. An answer naming a date the corpus
 * does not have is a problem whatever the report was about — so "it answers now"
 * does not close a report if what it answers with is unsupported. Closing that as
 * resolved would turn a silent gap into a confident invention and call it progress. */
const answersButInvents = triage(
  { reason: 'no-answer', query: 'when is the golf tournament', answer: "I don't have that information." },
  ['The golf tournament is Friday, September 4, 2026.', 'The golf tournament is Friday, September 4, 2026.']
)
check('answering with an unsupported date does not close a gap', answersButInvents.verdict, 'unsupported-date')
checkTrue('and still asks for a person', answersButInvents.needsHuman)

console.log('\n— what triage refuses to close —\n')

/* Nothing checkable is wrong and the answer has changed. Tempting to call fixed;
 * whether the new date is the school's is not knowable here. */
const changed = triage(
  { reason: 'wrong', query: 'when is jh picture day', answer: 'Picture Day is Thursday, August 27, 2026.' },
  ['Picture Day is Friday, August 28, 2026.', 'Picture Day is Friday, August 28, 2026.']
)
check('a changed answer is not called fixed', changed.verdict, 'changed-needs-eyes')
checkTrue('it says what changed', changed.detail.includes('2026-08-27') && changed.detail.includes('2026-08-28'))
checkTrue('and asks for eyes', changed.needsHuman)

// The app still says exactly what was complained about, and every check passes.
// Only the school can settle this one, and the verdict says so.
const same = triage(
  { reason: 'wrong', query: 'when is jh picture day', answer: 'Picture Day is Friday, August 28, 2026.' },
  ['Picture Day is Friday, August 28, 2026.', 'Picture Day is Friday, August 28, 2026.']
)
check('an unchanged answer needs the calendar', same.verdict, 'reproduces-needs-calendar')
checkTrue('and says that is what it needs', same.detail.includes("school's own calendar"))
check('nothing is pulled from cache — nothing detectable is wrong', same.actions, [])

// A run where the app could not be reached must not silently close anything.
const noReply = triage({ reason: 'wrong', query: 'when is picture day', answer: 'x' }, ['', ''])
check('an unaskable question is left alone', noReply.verdict, 'not-evaluated')
check('and is not counted as needing a human', noReply.needsHuman, false)

// One run is enough to check consistency, not enough to check stability.
const single = triage({ reason: 'wrong', query: 'q', answer: null }, ['The game is Thursday, August 20.'])
checkTrue('a single run is never called unstable', single.verdict !== 'unstable')

console.log('\n— the summary the dashboard reads —\n')

const summary = summarise([contradiction, invented, unstable, stillSilent, nowAnswers, answersButInvents, changed, same, noReply])
check('what was evaluated', summary.evaluated, 8)
check('what closed itself', summary.resolved, 1)
check('what needs a person', summary.needHuman, 7)
check('and the breakdown', summary.byVerdict, {
  'day-date-contradiction': 1, 'unsupported-date': 2, 'unstable': 1, 'no-answer': 1,
  'resolved': 1, 'changed-needs-eyes': 1, 'reproduces-needs-calendar': 1, 'not-evaluated': 1,
})

console.log('\n— the cache key triage has to reconstruct —\n')

/* Pulling a bad answer only works if the key matches the one the search route
 * wrote, which is why the key is built in one place now. */
check('the shape the search route writes', answerCacheKey('When is JH picture day?', '2026-08-11'),
  `answer:${CACHE_VERSION}:dev:2026-08-11:${answerCacheKey('When is JH picture day?', '2026-08-11').split(':').pop()}`)
check('two phrasings of one question share an entry',
  answerCacheKey('who is the middle school principal', TODAY),
  answerCacheKey('Whos the MS principal?', TODAY))
checkTrue('a different day is a different entry',
  answerCacheKey('when is the next game', '2026-08-11') !== answerCacheKey('when is the next game', '2026-08-12'))

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}\n`)
process.exit(failures ? 1 : 0)
