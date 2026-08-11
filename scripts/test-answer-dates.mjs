// Proof that no answer can leave here with a day name that contradicts its date.
//
// "JH Picture Day is Thursday, August 28, 2026" is self-evidently broken to
// anyone holding a calendar — August 28 is a Friday — and a parent who catches
// one stops believing the times as well. Run with:
//   node scripts/test-answer-dates.mjs
//
// Everything upstream of this (the day name written into the schedule line, the
// computed pairings, the prompt rule) makes that less likely. This is the part
// that makes it impossible, so it is tested the way it runs: on a stream, one
// arbitrary chunk boundary at a time, since the answer is already on its way to
// the browser while it is being checked.

import { checkAnswerDates, heldBackFrom } from '../src/lib/schedule.ts'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`}`)
}
const checkTrue = (name, actual) => check(name, actual, true)

const TODAY = '2026-08-11'
// What the retrieved context held: the real fixtures, picture day, the dance.
const CONTEXT = new Set([
  '2026-08-20', '2026-08-28', '2026-09-01', '2026-09-26', '2026-10-06', '2026-10-07',
])
const run = (text, contextDates = CONTEXT) => checkAnswerDates(text, { today: TODAY, contextDates })

console.log('\n— a date the context had: the day name is the wrong half —\n')

const reported = run('JH Picture Day is **Thursday, August 28, 2026** — order at inter-state.com.')
check('the reported answer comes out as a Friday',
  reported.text, 'JH Picture Day is **Friday, August 28, 2026** — order at inter-state.com.')
check('and the correction is reported', reported.corrected.map(f => `${f.was} -> ${f.now}`),
  ['Thursday, August 28, 2026 -> Friday, August 28, 2026'])
check('nothing is called unsupported', reported.unsupported.length, 0)

// The other half of the same answer, and the other reported failure.
check('the make-up day too', run('Picture Make-Up Day is Tuesday, October 7.').text,
  'Picture Make-Up Day is Wednesday, October 7.')
check('a fixture the model called a Saturday', run('The next game is Saturday, August 20 at 6:00 PM.').text,
  'The next game is Thursday, August 20 at 6:00 PM.')

// A correct pair is not touched — not re-spelled, not re-punctuated.
const fine = run('Picture Day is Friday, August 28, 2026, at the JH.')
check('a correct pair is left exactly alone', fine.text, 'Picture Day is Friday, August 28, 2026, at the JH.')
check('and reports nothing', [fine.corrected.length, fine.unsupported.length], [0, 0])

// Forms the model actually writes.
check('no comma after the day', run('It is on Thursday August 28.').text, 'It is on Friday August 28.')
check('an abbreviated month', run('Thursday, Aug. 28 at 8:00 AM').text, 'Friday, Aug. 28 at 8:00 AM')
check('an ordinal', run('Thursday, August 28th, 2026').text, 'Friday, August 28th, 2026')
check('lower case, mid-sentence', run('...on thursday, august 28.').text, '...on Friday, august 28.')
check('several pairs in one answer',
  run('The game is Saturday, August 20 and the dance is Sunday, September 26.').text,
  'The game is Thursday, August 20 and the dance is Saturday, September 26.')

console.log('\n— a date the context did not have: nothing is asserted —\n')

/* The dangerous case, and the reason the day name comes off instead of being
 * corrected. If the calendar says Thursday the 27th and the model writes
 * "Thursday, August 28", rewriting the day gives "Friday, August 28" — a
 * plausible, confident, wrong answer, and no one would ever spot it. Dropping the
 * day leaves the date the model claimed and adds no claim of its own. */
const invented = run('Picture Day is Thursday, August 29, 2026.')
check('the day name is dropped, not corrected', invented.text, 'Picture Day is August 29, 2026.')
check('and the pair is reported as unsupported', invented.unsupported.map(f => f.was), ['Thursday, August 29, 2026'])
check('it is not counted as a correction', invented.corrected.length, 0)
// A date that is in the context is corrected even when nothing else is.
check('an empty context asserts nothing at all',
  run('The game is Saturday, August 20.', new Set()).text, 'The game is August 20.')

console.log('\n— what is left alone —\n')

check('a day name with no date', run('Practices are Monday through Thursday, 3:30-5:30 PM.').text,
  'Practices are Monday through Thursday, 3:30-5:30 PM.')
check('a date with no day name', run('Picture Day is August 28, 2026.').text, 'Picture Day is August 28, 2026.')
check('a date that does not exist', run('Thursday, February 30, 2026').text, 'Thursday, February 30, 2026')
check('a school year', run('the 2026-27 school year begins Thursday, August 20').text,
  'the 2026-27 school year begins Thursday, August 20')
check('prose with no dates in it', run('The JH principal is Mr. Walters.').text, 'The JH principal is Mr. Walters.')

// A bare month and day is resolved against the context first, and only then by
// proximity to today — so an answer about a date the schedule holds gets that
// year rather than a guess.
check('a bare date takes the year the context has', run('The game is Saturday, October 6.').text,
  'The game is Tuesday, October 6.')

console.log('\n— on a stream, at every chunk boundary —\n')

/* The check runs while the answer is already going out, so it has to be right for
 * any split of the text — the model's chunk boundaries are not ours to choose.
 * `heldBackFrom` is what makes that safe: text is only released up to the point
 * where a date phrase could still be forming. */
function streamThrough(text, size) {
  let pending = ''
  let out = ''
  const corrected = []
  const unsupported = []
  const release = (final) => {
    const cut = final ? pending.length : heldBackFrom(pending)
    if (cut <= 0) return
    const checked = checkAnswerDates(pending.slice(0, cut), { today: TODAY, contextDates: CONTEXT })
    pending = pending.slice(cut)
    corrected.push(...checked.corrected)
    unsupported.push(...checked.unsupported)
    out += checked.text
  }
  for (let i = 0; i < text.length; i += size) {
    pending += text.slice(i, i + size)
    release(false)
  }
  release(true)
  return { out, corrected, unsupported }
}

const ANSWER = 'JH Picture Day is **Thursday, August 28, 2026** at 8:00 AM, and the make-up day is Tuesday, October 7.'
const EXPECTED = 'JH Picture Day is **Friday, August 28, 2026** at 8:00 AM, and the make-up day is Wednesday, October 7.'

let widths = 0
for (let size = 1; size <= 40; size++) {
  const { out } = streamThrough(ANSWER, size)
  if (out === EXPECTED) widths++
  else { console.log(`FAIL  chunk width ${size} produced: ${JSON.stringify(out)}`); failures++ }
}
check('every chunk width from 1 to 40 gives the same corrected answer', widths, 40)

// One character at a time is the worst case: the phrase arrives letter by letter
// and must never be released half-checked.
const perChar = streamThrough(ANSWER, 1)
check('and the corrections are reported once each, not per chunk', perChar.corrected.length, 2)

// Nothing is ever lost or duplicated by the holdback, whatever the text.
const SAMPLES = [
  'Sunday', 'Monday, ', 'It is Thu', 'Thursday, August', 'Wednesday, September 28th, 2026',
  'The office opens at 7:30 AM.', 'Sunset is late in June.', '',
]
checkTrue('the holdback never drops or repeats a character', SAMPLES.every(sample =>
  [1, 3, 7, 100].every(size => streamThrough(sample, size).out === run(sample).text)))
// The holdback only ever reaches back behind something that looks like a day name.
check('nothing is held back with no day name in sight', heldBackFrom('The office opens at 7:30 AM.'), 28)
check('a trailing partial day name is held', heldBackFrom('The game is on Thurs'), 15)
check('a completed phrase is not held forever', heldBackFrom('Thursday, August 28, 2026 at the JH, in the gym.'), 48)

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}\n`)
process.exit(failures ? 1 : 0)
