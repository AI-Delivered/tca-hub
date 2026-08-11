// Proof that the corpus audit finds each defect this project has actually had.
//
// Run with: node scripts/test-audit.mjs
//
// Every case below is a bug that shipped, reported success, and was found later by
// a person rather than by the app. The audit runs on a cron over the real corpus,
// so these are the fixtures it has to catch — and the last section is the one that
// makes it worth reading at all: a healthy corpus must produce nothing.

import { runAudit } from '../src/lib/audit.ts'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`}`)
}
const checkTrue = (name, actual) => check(name, actual, true)

const TODAY = '2026-08-11'
const GOBOUND = 'https://gobound.com/co/schools/theclassahs/calendar'
const ICAL = 'https://gobound.com/co/schools/theclassahs/calendar?v=list#volleyball'
const audit = (chunks, answers = []) => runAudit({ chunks, answers, today: TODAY })
const chunk = (url, content, title = 'TCA Athletics & Activities — Upcoming Schedule') => ({ url, title, content })

// A corpus in the shape the code expects: ISO date, day name spelled out, h:mm.
const HEALTHY = [
  chunk(GOBOUND, [
    'TCA Athletics & Activities — Upcoming Schedule (as of 2026-08-11):',
    '2026-08-20 (Thursday) 6:00 PM–7:30 PM — TCA vs Palmer Ridge @ TCA HS Main Gym',
    '2026-08-28 (Friday) 8:00 AM–10:00 AM — JH Picture Day @ North Campus',
    '2026-11-24 (Tuesday) — No School',
  ].join('\n')),
]

console.log('\n— the format bugs that reported success —\n')

/* `4 PM` where the filters need `4:00 PM`. Most of an eighteen-week schedule was
 * invisible to a list the model is told is COMPLETE, and the insert count never
 * moved. This is the check that would have caught it the next morning. */
const shortTimes = audit([chunk(GOBOUND, [
  '2026-08-28 4 PM–6 PM — JH Picture Day @ North Campus',
  '2026-08-29 4 PM–6 PM — Volleyball vs Palmer Ridge',
].join('\n'))])
check('a line the event filters cannot see is an error', shortTimes.counts['dated-line-unreadable'], 2)
check('and it says what to do about it', shortTimes.findings[0].action.includes('disagree on the line format'), true)
check('it counts as an error, not a warning', shortTimes.errors >= 2, true)

/* A day name this code wrote itself, disagreeing with its own date: a timezone or
 * offset bug at ingest, which is what the month-based DST guess produced for every
 * floating-time event in late March. */
const wrongDay = audit([chunk(ICAL, '[Volleyball Varsity (Girls)] 2026-08-28 (Thursday) 6:00 PM–7:30 PM: TCA vs Lewis-Palmer')])
check('a wrong day name in a stored line', wrongDay.counts['weekday-wrong-in-line'], 1)
checkTrue('is called this code\'s bug, not the school\'s',
  wrongDay.findings[0].action.includes('not a source error'))

console.log('\n— the picture day question, found automatically —\n')

/* The finding that would have answered the question that started all of this, on
 * the day the newsletter was ingested, by naming the source to go and ask. */
const sourceTypo = audit([chunk('email://jh-newsletter',
  'JH Picture Day is Thursday, August 28, 2026. Order at inter-state.com, code 0150JDF.\nThe Classical Academy Junior High.',
  'JH Newsletter')])
check('the school\'s own text contradicting itself', sourceTypo.counts['weekday-wrong-in-source'], 1)
check('the finding states both readings',
  sourceTypo.findings[0].what, 'the source prints "Thursday, August 28, 2026" — Friday, August 28, 2026')
checkTrue('and sends it to a human, not to a rewrite',
  sourceTypo.findings[0].action.includes('ask the office'))
check('it is a warning — nothing here knows which half is wrong', sourceTypo.findings[0].severity, 'warn')

console.log('\n— sources that go quiet without failing —\n')

/* A feed pointed at a division whose last event was months past inserted zero
 * chunks and reported zero, and zero reads as "nothing new". */
const stale = audit([chunk('https://www.tcatitans.org/schools/central-elementary/central-elementary-calendar',
  '2026-05-21 (Thursday) 9:00 AM — Last Day of School', 'Central Elementary Calendar')])
check('a calendar whose newest event is past', stale.counts['source-stale'], 1)
checkTrue('names the feed as the thing to check', stale.findings[0].action.includes('feed URL'))
check('a source with upcoming events is not stale', audit(HEALTHY).counts['source-stale'], undefined)

console.log('\n— two sources, one event, two times —\n')

const conflict = audit([
  chunk(ICAL, '[Volleyball Varsity (Girls)] 2026-08-20 (Thursday) 6:00 PM–7:30 PM: TCA vs Palmer Ridge @ Gym'),
  chunk('https://api.teamreach.net/api/events/teams/20623/ical',
    '[Volleyball Varsity (Girls)] 2026-08-20 (Thursday) 6:30 PM–8:00 PM: TCA vs Palmer Ridge @ Gym', 'TCA Volleyball'),
])
check('the same fixture at two times in two sources', conflict.counts['time-conflict'], 1)
/* JV at 4:30 and Varsity at 6:00 on the same afternoon is a schedule, not a
 * disagreement — which is why the level tag is part of the key. */
const twoTeams = audit([
  chunk(ICAL, '[Volleyball JV (Girls)] 2026-08-20 (Thursday) 4:30 PM–6:00 PM: TCA vs Palmer Ridge @ Gym'),
  chunk('https://api.teamreach.net/x', '[Volleyball Varsity (Girls)] 2026-08-20 (Thursday) 6:00 PM–7:30 PM: TCA vs Palmer Ridge @ Gym', 'TR'),
])
check('two teams playing the same opponent is not a conflict', twoTeams.counts['time-conflict'], undefined)
// One source listing an event twice at two times is a source problem, not a
// cross-source disagreement, and this check is only about the latter.
check('one source alone is not a cross-source conflict', audit([
  chunk(ICAL, ['[V] 2026-08-20 (Thursday) 6:00 PM: TCA vs Palmer Ridge', '[V] 2026-08-20 (Thursday) 6:30 PM: TCA vs Palmer Ridge'].join('\n')),
]).counts['time-conflict'], undefined)

console.log('\n— another school\'s newsletter wearing this school\'s name —\n')

const wrongSchool = audit([chunk('email://titan-enews',
  'Titan eNews — Weekly Campus Update. Colorado Springs. Contact frontoffice@asd20.org. Picture Day is Tuesday, September 8.',
  'Titan eNews')])
check('pasted content that never names the school', wrongSchool.counts['unnamed-school'], 1)
check('TCA\'s own newsletter raises nothing', audit([chunk('email://jh-newsletter',
  'TCA Junior High Weekly. Questions? frontoffice@asd20.org', 'JH Weekly')]).counts['unnamed-school'], undefined)
// Crawled pages are not pasted by hand and are not subject to this check.
check('a page from the school website is not questioned', audit([chunk(
  'https://www.tcatitans.org/family/staff-directory', 'Leadership: Mr. Walters', 'Staff')]).counts['unnamed-school'], undefined)

console.log('\n— what the app actually told parents —\n')

/* The stream guard makes a day/date contradiction impossible on the way out, so
 * one appearing in the log means the guard is not deployed or not reached. Worth
 * hearing from the traffic rather than from a parent. */
const badAnswer = audit(HEALTHY, [
  { query: 'when is jh picture day', answer: 'JH Picture Day is Thursday, August 28, 2026 at 8:00 AM.' },
])
check('an answer whose day and date disagree', badAnswer.counts['answer-day-date-contradiction'], 1)
checkTrue('and it points at the deployed build',
  badAnswer.findings.find(f => f.check === 'answer-day-date-contradiction').action.includes('deployed build'))

/* A date the model produced rather than read. No retrieval fix can catch this one,
 * which is exactly why it is worth counting. */
const invented = audit(HEALTHY, [
  { query: 'when is picture day', answer: 'Picture Day is Friday, September 4, 2026.' },
])
check('a date that appears in no chunk', invented.counts['answer-date-not-in-corpus'], 1)
check('a date the corpus has is not flagged', audit(HEALTHY, [
  { query: 'when is picture day', answer: 'Picture Day is Friday, August 28, 2026.' },
]).counts['answer-date-not-in-corpus'], undefined)

console.log('\n— a healthy corpus, and the cap —\n')

/* The check that makes the rest worth reading. An audit that always finds
 * something is an audit nobody opens. */
const clean = audit(HEALTHY, [
  { query: 'when is jh picture day', answer: 'JH Picture Day is Friday, August 28, 2026 at 8:00 AM.' },
  { query: 'when is the next volleyball game', answer: 'Thursday, August 20 at 6:00 PM against Palmer Ridge.' },
])
check('finds nothing wrong', clean.findings, [])
check('and says so in numbers', [clean.errors, clean.warnings], [0, 0])
check('while reporting what it looked at', clean.checked, { chunks: 1, answers: 2, sources: 1 })
// An all-day entry is an event, and a correct one raises nothing.
checkTrue('an all-day no-school day is not a finding', !clean.counts['dated-line-unreadable'])

/* One systemic fault produces thousands of instances of itself. The `4 PM` bug
 * would have reported every event in an eighteen-week schedule. */
const many = audit([chunk(GOBOUND,
  Array.from({ length: 200 }, (_, i) => `2026-09-${String((i % 28) + 1).padStart(2, '0')} 4 PM–6 PM — Game ${i}`).join('\n'))])
check('the count is complete', many.counts['dated-line-unreadable'], 200)
check('the examples are capped', many.findings.filter(f => f.check === 'dated-line-unreadable').length, 5)

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}\n`)
process.exit(failures ? 1 : 0)
