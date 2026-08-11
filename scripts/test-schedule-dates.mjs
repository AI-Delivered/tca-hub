// Proof that a day of the week reaching an answer is the day the date is on.
//
// The failure this is written against: "JH Picture Day is Thursday, August 28,
// 2026", when August 28, 2026 is a Friday. Run with:
//   node scripts/test-schedule-dates.mjs
//
// Two things are checked, and the second is the one that would have caught the
// picture day answer. First, that the weekday arithmetic is right — including
// across the DST changes and in a process running in UTC, where a date parsed
// the wrong way is a day out and looks fine everywhere else. Second, that a line
// an ingest route writes is a line the search route's filters can see: those
// filters build a list they hand to the model labelled COMPLETE, so a format the
// regex misses is not a formatting problem, it is a wrong answer.

import {
  weekdayFor, longDate, formatClock, scheduleLine, datesIn, weekdayNote, DATED_LINE,
} from '../src/lib/schedule-dates.ts'

let failures = 0
const check = (name, actual, expected) => {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`}`)
}
const checkTrue = (name, actual) => check(name, actual, true)

console.log('\n— weekdayFor —\n')

// The reported case, and the date the wrong day name would have sent a parent to.
check('2026-08-28 is a Friday (the picture day answer said Thursday)', weekdayFor('2026-08-28'), 'Friday')
check('2026-08-27 is a Thursday', weekdayFor('2026-08-27'), 'Thursday')
check('2026-10-07 is a Wednesday (make-up day answer said Tuesday)', weekdayFor('2026-10-07'), 'Wednesday')
check('2026-10-06 is a Tuesday', weekdayFor('2026-10-06'), 'Tuesday')

// A date parsed as UTC midnight and read back in Denver lands on the day before,
// which is exactly the shape of the bug. These are the days either side of a
// change of offset, where that slip is most likely and least visible.
check('2026-03-08, the spring forward', weekdayFor('2026-03-08'), 'Sunday')
check('2026-11-01, the fall back', weekdayFor('2026-11-01'), 'Sunday')
check('2026-01-01', weekdayFor('2026-01-01'), 'Thursday')
check('2026-12-31', weekdayFor('2026-12-31'), 'Thursday')
check('2027-01-01, across the year boundary', weekdayFor('2027-01-01'), 'Friday')
check('2028-02-29, a leap day', weekdayFor('2028-02-29'), 'Tuesday')

// Nothing is better than a confident wrong day: Date.UTC would roll February 30
// forward to March 2 and report a Thursday for a date that does not exist.
check('2026-02-30 is not a date', weekdayFor('2026-02-30'), '')
check('2026-13-01 is not a date', weekdayFor('2026-13-01'), '')
check('a bare month and day has no weekday', weekdayFor('08-28'), '')
check('prose is not a date', weekdayFor('August 28, 2026'), '')
check('empty input', weekdayFor(''), '')

check('longDate spells the pairing out', longDate('2026-08-28'), 'Friday, August 28, 2026')
check('longDate on a non-date', longDate('2026-02-30'), '')

console.log('\n— formatClock —\n')

check('on the hour keeps its minutes', formatClock('2026-08-28T16:00:00'), '4:00 PM')
check('quarter past', formatClock('2026-08-28T16:15:00'), '4:15 PM')
check('midnight', formatClock('2026-08-28T00:00:00'), '12:00 AM')
check('noon', formatClock('2026-08-28T12:00:00'), '12:00 PM')
check('a bare clock time', formatClock('08:30'), '8:30 AM')
check('an all-day value has no time', formatClock('2026-08-28'), '')
check('nonsense hour', formatClock('2026-08-28T99:00:00'), '')

console.log('\n— scheduleLine —\n')

const pictureDay = {
  date: '2026-08-28',
  startDateTime: '2026-08-28T08:00:00',
  endDateTime: '2026-08-28T10:00:00',
  name: 'JH Picture Day',
  location: 'North Campus',
}
check(
  'the day name is in the line, spelled out',
  scheduleLine(pictureDay),
  '2026-08-28 (Friday) 8:00 AM–10:00 AM — JH Picture Day @ North Campus'
)
check(
  'a cancelled event says so',
  scheduleLine({ ...pictureDay, location: '', cancelled: true }),
  '2026-08-28 (Friday) 8:00 AM–10:00 AM — JH Picture Day [CANCELLED]'
)
check(
  'no end time, no range',
  scheduleLine({ date: '2026-08-28', startDateTime: '2026-08-28T08:00:00', name: 'JH Picture Day' }),
  '2026-08-28 (Friday) 8:00 AM — JH Picture Day'
)
check(
  'an all-day event still carries its day',
  scheduleLine({ date: '2026-08-28', name: 'JH Picture Day' }),
  '2026-08-28 (Friday) — JH Picture Day'
)

// The invariant that matters: the search route decides what is an event with
// DATED_LINE and tells the model the resulting list is COMPLETE. An event on the
// hour used to be written `4 PM–6 PM` and matched nothing, so it was absent from
// a list asserted to hold everything.
checkTrue('an on-the-hour event is visible to DATED_LINE', DATED_LINE.test(scheduleLine(pictureDay)))
checkTrue(
  'so is one at quarter past',
  DATED_LINE.test(scheduleLine({ ...pictureDay, startDateTime: '2026-08-28T16:15:00', endDateTime: '2026-08-28T18:15:00' }))
)
checkTrue(
  'and one behind an ical level tag',
  DATED_LINE.test(`[Volleyball Varsity (Girls)] ${scheduleLine(pictureDay)}`)
)
check(
  'the date DATED_LINE reports is the event date',
  scheduleLine(pictureDay).match(DATED_LINE)[1],
  '2026-08-28'
)
// An all-day line has no clock time and is deliberately not an "event" for the
// filters — a list of dated events is meant to carry times a parent can use.
check('an all-day line is not a dated event', DATED_LINE.test(scheduleLine({ date: '2026-08-28', name: 'No School' })), false)

console.log('\n— datesIn —\n')

const newsletter = `Picture Day is Thursday, August 28, 2026 at the JH.
Order online at www.inter-state.com with Event Order Code 0150JDF.
Make-Up Day is Tuesday, October 6, 2026. Sept 4, 2026 is a teacher work day.
Fall conferences are October 15 — watch for a sign-up.
2026-09-26 6:00 PM–9:00 PM — Homecoming Dance`

const found = datesIn(newsletter)
check('every dated form is found once', found.map(d => d.ymd).join(','), '2026-08-28,2026-09-04,2026-09-26,2026-10-06')
check('a prose date carries what the source printed', found[0].written, 'Thursday, August 28, 2026')
check('an abbreviated month is read', found[1].ymd, '2026-09-04')
check('an ISO line is found too', found[2].prose, false)
checkTrue('a bare "October 15" is left out — its year is a guess', !found.some(d => d.ymd.endsWith('-10-15')))
check('no dates, no entries', datesIn('The office opens at 7:30 AM.').length, 0)
check('an impossible date is not reported', datesIn('February 30, 2026').length, 0)

console.log('\n— weekdayNote —\n')

const note = weekdayNote(newsletter)
checkTrue('the pairing the answer needs is stated', note.includes('2026-08-28 = Friday, August 28, 2026'))
checkTrue('and the one for the make-up day', note.includes('2026-10-06 = Tuesday, October 6, 2026'))
checkTrue('the model is told not to work one out itself', /[Nn]ever work a day of the week out yourself/.test(note))
checkTrue(
  "the source's own contradiction is handed over rather than resolved",
  note.includes('The context prints "Thursday, August 28, 2026". That date is a Friday.')
)
checkTrue(
  'a source that agrees with the calendar raises nothing',
  !weekdayNote('Picture Day is Friday, August 28, 2026.').includes('The context prints')
)
check('no dates, no note', weekdayNote('The office opens at 7:30 AM.'), '')

// A season's schedule can name a hundred dates; the note is capped so it cannot
// crowd out the pages themselves, and the prose ones — the dates with no day
// name beside them in the line — are the ones that survive the cap.
const season = Array.from({ length: 60 }, (_, i) => `2026-09-${String((i % 30) + 1).padStart(2, '0')} 6:00 PM — Game ${i}`)
  .join('\n') + '\nPicture Day is Thursday, August 28, 2026.'
const capped = weekdayNote(season)
checkTrue('the pairing list is capped', capped.split('\n').filter(l => / = /.test(l)).length <= 40)
checkTrue('the prose date survives the cap', capped.includes('2026-08-28 = Friday, August 28, 2026'))

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}\n`)
process.exit(failures ? 1 : 0)
