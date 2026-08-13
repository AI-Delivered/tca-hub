// Proof that the "still adding sources" line lands on gaps and nothing else.
//
// Run with: node scripts/test-gap-note.mjs
//
// Two ways to get this wrong, and both are worse than not having it. Put it on an
// answer that did answer, and the app looks unsure of facts it has. Put it on an
// outage, and a parent is asked to be patient about the wrong thing entirely —
// "TCA hasn't published this yet" when the truth is the assistant is down.

import { GAP_NOTE, withGapNote, gapNoteFor, saidItCouldNotAnswer } from '../src/lib/unanswered.ts'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`}`)
}
const checkTrue = (name, actual) => check(name, actual, true)

console.log('\n— where it belongs —\n')

const gap = "I don't have the golf coach's name in the available data."
check('an answer that admits a gap gets it', withGapNote(gap), `${gap}\n\n${GAP_NOTE}`)
checkTrue('as its own paragraph, so markdown renders it apart', withGapNote(gap).includes('\n\n*'))

// The voices the model actually declines in — all of these are gaps.
for (const answer of [
  "I couldn't find information about that on the TCA website.",
  'The 2026-27 playoff dates haven\'t been posted yet.',
  'Practice dates aren\'t listed in the upcoming schedule.',
  'That is not in the context I was given.',
]) {
  checkTrue(`"${answer.slice(0, 42)}…"`, withGapNote(answer).endsWith(GAP_NOTE))
}

console.log('\n— where it does not —\n')

const answered = 'The JH day ends at 3:00 PM, Monday through Thursday.'
check('a real answer is untouched', withGapNote(answered), answered)
check('and there is nothing to append', gapNoteFor(answered), '')

/* An outage is not a gap. "More sources are being added, thanks for your patience"
 * is the wrong thing to say when the truth is that the assistant is down and the
 * data was there all along. */
const outage = "I can't write a full answer right now — the assistant is temporarily unavailable. The links below should have what you're looking for."
checkTrue('the outage copy does not read as a gap', !saidItCouldNotAnswer(outage))
check('so it is left alone', withGapNote(outage), outage)

check('an empty answer gets nothing', withGapNote(''), '')
check('and neither does whitespace', withGapNote('   '), '   ')

console.log('\n— appended once, whatever happens —\n')

/* A cached answer already carries the note, and a follow-up turn re-reads the
 * conversation. Stacking a second copy underneath the first is the obvious way for
 * this to look broken. */
const already = withGapNote(gap)
check('a second pass adds nothing', withGapNote(already), already)
check('and reports nothing to append', gapNoteFor(already), '')

// What the streaming path appends: exactly the difference, so the text the parent
// reads matches the text that is cached and logged.
check('the streamed fragment is the paragraph break plus the note',
  gapNoteFor(gap), `\n\n${GAP_NOTE}`)
check('answer plus fragment is the whole thing', gap + gapNoteFor(gap), withGapNote(gap))
// A model answer that ends mid-whitespace must not gain a ragged join.
check('trailing whitespace is not doubled', withGapNote(`${gap}\n\n`), `${gap}\n\n${GAP_NOTE}`)

console.log('\n— the wording itself —\n')

/* The obvious phrasing claims a working relationship with the school, and this
 * app's own system prompt says it is not built, run, endorsed or approved by The
 * Classical Academy. If that relationship does come to exist, this assertion is
 * the reminder that the disclaimer has to move with the copy. */
checkTrue('it does not claim to be working with the school',
  !/\bworking with (tca|the classical academy)\b/i.test(GAP_NOTE))
checkTrue('it does not speak for the school', !/\bwe (are|have) (partnered|arranged)\b/i.test(GAP_NOTE))
checkTrue('it says sources are still arriving', /more sources are being added/i.test(GAP_NOTE))
checkTrue('and it thanks the person waiting', /patience/i.test(GAP_NOTE))
checkTrue('it is one line', !GAP_NOTE.includes('\n'))

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}\n`)
process.exit(failures ? 1 : 0)
