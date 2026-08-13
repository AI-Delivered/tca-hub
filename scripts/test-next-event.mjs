// Proof that "when is the next game" gives the same answer every time.
//
// The failure this is written against: the same question answered "Saturday,
// August 20 … against Palmer Ridge" one time and "Tuesday, September 1 …
// against Lewis-Palmer" the next. Run with:
//   node scripts/test-next-event.mjs
//
// A schedule document is stored as many 1,800-character rows sharing one url and
// title, and the route used to anchor that title with `.limit(1)` and no
// ordering — so which slice of the season reached the model was Postgres's
// choice and changed after every nightly re-ingest. The test that matters here is
// the permutation one: every ordering of the same pieces has to produce the same
// next game, because row order is the thing that was never guaranteed.

import {
  assemblePieces, assembleByUrl, datedLines, nextEventsByLevel, levelsAskedFor, isGame, isPractice,
  eventsInRange,
} from '../src/lib/schedule.ts'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`}`)
}
const checkTrue = (name, actual) => check(name, actual, true)

const TODAY = '2026-08-11'
const GYM = 'The Classical Academy High School Main Gym'

const line = (level, ymd, dow, time, rest) =>
  `  [${level}] ${ymd} (${dow}) ${time}: ${rest}`

// The real shape of the corpus: one document per source, split into pieces, and
// the same fixtures appearing in both GoBound's aggregate view and the per-level
// schedule.
const VARSITY_PAST = line('Volleyball Varsity (Girls)', '2026-08-05', 'Wednesday', '6:00 PM–7:30 PM', `TCA vs Discovery Canyon @ ${GYM}`)
const VARSITY_NEXT = line('Volleyball Varsity (Girls)', '2026-08-20', 'Thursday', '6:00 PM–7:30 PM', `TCA vs Palmer Ridge @ ${GYM}`)
const JV_NEXT = line('Volleyball JV (Girls)', '2026-08-20', 'Thursday', '4:30 PM–6:00 PM', `TCA vs Palmer Ridge @ ${GYM}`)
const VARSITY_LATER = line('Volleyball Varsity (Girls)', '2026-09-01', 'Tuesday', '6:00 PM–7:30 PM', `TCA vs Lewis-Palmer @ ${GYM}`)
const VARSITY_PRACTICE = line('Volleyball Varsity (Girls)', '2026-08-12', 'Wednesday', '3:30 PM–5:30 PM', 'Practice @ North Campus Auxiliary Gym')
const HOME_AT_NORTH = line('Volleyball JH A (Girls)', '2026-08-18', 'Tuesday', '4:00 PM–5:30 PM', 'TCA vs Chinook Trail @ The Classical Academy North Campus')

console.log('\n— isGame / isPractice —\n')

checkTrue('a fixture is a game', isGame(VARSITY_NEXT))
checkTrue('a practice is not a game', !isGame(VARSITY_PRACTICE))
checkTrue('a practice is a practice', isPractice(VARSITY_PRACTICE))
// The reason `camps?` is anchored: unanchored it matches "North Campus", where
// most home fixtures are played, and every home game reads as a practice.
checkTrue('a home game at North Campus is still a game', isGame(HOME_AT_NORTH))
checkTrue('and is not a practice', !isPractice(HOME_AT_NORTH))

/* Half of TCA's sports do not play one named opponent, and " vs " was the whole
 * test — so "when is the next cross country meet" had no line to compute from. */
const INVITATIONAL = line('Cross Country Varsity (Girls)', '2026-09-12', 'Saturday', '9:00 AM', 'Liberty Bell Invitational @ Woodland Park')
const ALL_DAY_MEET = '[Track & Field Varsity (Boys)] 2026-05-15 (Friday) — State Championships @ Jeffco Stadium'
checkTrue('an invitational is a competition', isGame(INVITATIONAL))
checkTrue('so is an all-day championship with no time at all', isGame(ALL_DAY_MEET))
checkTrue('a swim triangular counts', isGame(line('Swim Varsity (Girls)', '2026-09-12', 'Saturday', '9:00 AM', 'Triangular @ Air Academy')))
// A school calendar is full of these, and calling one a competition offers a
// parent an evening in a classroom as their child's next race.
checkTrue('"Meet the Teacher" is not a competition', !isGame(line('', '2026-08-14', 'Friday', '5:00 PM', 'Meet the Teacher @ North Campus')))
checkTrue('nor is a Meet and Greet', !isGame(line('', '2026-08-14', 'Friday', '5:00 PM', 'Fall Sports Meet and Greet')))
checkTrue('nor is picture day', !isGame('2026-08-28 (Friday) 8:00 AM–10:00 AM — JH Picture Day @ North Campus'))
// The next meet is computable now, which is the point of the above.
check('the next meet can be computed', nextEventsByLevel(
  datedLines([INVITATIONAL, ALL_DAY_MEET].join('\n')), { today: TODAY, kind: 'game' }
).map(e => e.ymd), ['2026-09-12'])

console.log('\n— assemblePieces —\n')

// chunkText re-opens each piece with the last whole lines of the one before it.
const pieceA = ['TCA Athletics — Upcoming Events:', VARSITY_PAST, VARSITY_PRACTICE].join('\n')
const pieceB = [VARSITY_PRACTICE, VARSITY_NEXT, JV_NEXT].join('\n')
const pieceC = [JV_NEXT, VARSITY_LATER].join('\n')
const doc = assemblePieces([
  { id: 3, url: 'u', title: 't', content: pieceC },
  { id: 1, url: 'u', title: 't', content: pieceA },
  { id: 2, url: 'u', title: 't', content: pieceB },
])
check('pieces are joined in id order, whatever order they arrive in', doc, [
  'TCA Athletics — Upcoming Events:', VARSITY_PAST, VARSITY_PRACTICE, VARSITY_NEXT, JV_NEXT, VARSITY_LATER,
].join('\n'))
check('the overlap seam is not repeated', doc.split('\n').filter(l => l === JV_NEXT).length, 1)
check('every event survives the join', datedLines(doc).length, 5)

check('one document per url', assembleByUrl([
  { id: 2, url: 'b', title: 'B', content: VARSITY_LATER },
  { id: 1, url: 'a', title: 'A', content: VARSITY_NEXT },
  { id: 3, url: 'a', title: 'A', content: JV_NEXT },
]).map(d => `${d.url}:${d.content.split('\n').length}`), ['a:2', 'b:1'])

console.log('\n— datedLines —\n')

const lines = datedLines(doc)
check('dated lines come back in date order', lines.map(l => l.ymd), [
  '2026-08-05', '2026-08-12', '2026-08-20', '2026-08-20', '2026-09-01',
])
check('same day, earlier time first', lines.filter(l => l.ymd === '2026-08-20').map(l => l.minutes), [16 * 60 + 30, 18 * 60])
check('the level tag is read off the line', lines[0].level, 'Volleyball Varsity (Girls)')
check('an undated line is not an event', datedLines('TCA Athletics — Upcoming Events:').length, 0)
// The aggregate view and the per-level schedule both carry the same fixture.
check('the same line from two documents is one event', datedLines([VARSITY_NEXT, VARSITY_NEXT].join('\n')).length, 1)

console.log('\n— nextEventsByLevel —\n')

const next = nextEventsByLevel(lines, { today: TODAY, kind: 'game' })
check('the next game per level, earliest first', next.map(e => `${e.level} ${e.ymd}`), [
  'Volleyball JV (Girls) 2026-08-20',
  'Volleyball Varsity (Girls) 2026-08-20',
])
checkTrue('Varsity\'s next game is Palmer Ridge on the 20th, not Lewis-Palmer on the 1st',
  next.find(e => e.level.includes('Varsity')).lines.join().includes('Palmer Ridge'))
checkTrue('the September fixture is not offered', !next.some(e => e.lines.join().includes('Lewis-Palmer')))
checkTrue('a game already played is not "next"', !next.some(e => e.lines.join().includes('Discovery Canyon')))
checkTrue('a practice is not an answer to "next game"', !next.some(e => e.lines.join().includes('Practice')))

const nextPractice = nextEventsByLevel(lines, { today: TODAY, kind: 'practice' })
check('and the next practice is the practice', nextPractice.map(e => e.ymd), ['2026-08-12'])

// Both teams playing that afternoon are returned: a parent with a player on the
// other one needs their time too.
const sameDay = nextEventsByLevel(datedLines([VARSITY_NEXT, JV_NEXT].join('\n')), { today: TODAY, kind: 'game' })
check('both teams playing that day are named', sameDay.flatMap(e => e.lines).length, 2)

// Today counts. A game this evening is still the next game.
check('an event today is upcoming', nextEventsByLevel(
  datedLines(line('Volleyball Varsity (Girls)', TODAY, 'Tuesday', '6:00 PM', `TCA vs Air Academy @ ${GYM}`)),
  { today: TODAY, kind: 'game' }
).map(e => e.ymd), [TODAY])

check('nothing upcoming, nothing claimed', nextEventsByLevel(
  datedLines(VARSITY_PAST), { today: TODAY, kind: 'game' }
).length, 0)

console.log('\n— levelsAskedFor —\n')

const LEVELS = [
  'Volleyball Varsity (Girls)', 'Volleyball JV (Girls)', 'Volleyball JH A (Girls)',
  'Volleyball JH B (Girls)', 'Basketball Varsity (Boys)',
]
check('a named level wins', levelsAskedFor("when is varsity volleyball's next game", LEVELS.filter(l => l.startsWith('Volleyball'))),
  ['Volleyball Varsity (Girls)'])
// This reads the team out of the question and nothing else — the sport is the
// caller's to narrow, and the search route does it before this is reached.
// Without that, "varsity volleyball" would pull in Basketball Varsity as well.
check('the sport is not this function\'s business', levelsAskedFor("when is varsity volleyball's next game", LEVELS),
  ['Volleyball Varsity (Girls)', 'Basketball Varsity (Boys)'])
// "Junior varsity" contains "varsity", and answering it with Varsity's fixture
// too is how a JV parent ends up at the wrong game.
check('junior varsity is not varsity', levelsAskedFor('next junior varsity volleyball game', LEVELS), ['Volleyball JV (Girls)'])
check('so is the abbreviation', levelsAskedFor('next jv volleyball game', LEVELS), ['Volleyball JV (Girls)'])
check('junior high means both JH teams', levelsAskedFor('next junior high volleyball game', LEVELS),
  ['Volleyball JH A (Girls)', 'Volleyball JH B (Girls)'])
check('and so does middle school', levelsAskedFor('next middle school volleyball game', LEVELS),
  ['Volleyball JH A (Girls)', 'Volleyball JH B (Girls)'])
check('the JH B team on its own', levelsAskedFor('when does the JH B team play next', LEVELS), ['Volleyball JH B (Girls)'])
// Level and sex are separate categories, so naming both narrows rather than widens.
check('girls varsity is one team, not every girls team', levelsAskedFor('next girls varsity game', LEVELS),
  ['Volleyball Varsity (Girls)'])
check('boys is the basketball team here', levelsAskedFor('when is the next boys game', LEVELS), ['Basketball Varsity (Boys)'])
check('no level named, nothing claimed', levelsAskedFor('when is the next volleyball game', LEVELS), [])
check('a level named that has no team', levelsAskedFor('next c-squad volleyball game', LEVELS), [])

console.log('\n— the same answer every time —\n')

/* The regression test for the reported failure.
 *
 * Row order was never guaranteed and the route depended on it, so this asserts
 * over every permutation of the pieces rather than the one the database happened
 * to return: assemble, compute, and the next Varsity game is the same fixture
 * each time. Under the old `.limit(1)`, piece B answers Palmer Ridge and piece C
 * answers Lewis-Palmer — the two answers actually reported. */
const pieces = [
  { id: 1, url: 'u', title: 't', content: pieceA },
  { id: 2, url: 'u', title: 't', content: pieceB },
  { id: 3, url: 'u', title: 't', content: pieceC },
]
const permutations = (xs) => xs.length <= 1 ? [xs]
  : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(rest => [x, ...rest]))

const answers = new Set(permutations(pieces).map(order => {
  const events = nextEventsByLevel(datedLines(assemblePieces(order)), { today: TODAY, kind: 'game' })
  return events.find(e => e.level.includes('Varsity'))?.lines.join('|')
}))
check('all 6 row orderings give one answer', answers.size, 1)
checkTrue('and it is the 20 August fixture', [...answers][0].includes('2026-08-20') && [...answers][0].includes('Palmer Ridge'))

// A single arbitrary piece is what the route used to hand over, and it is where
// the two different answers came from. Kept as a statement of the cause.
check('one piece alone disagrees with another', new Set([pieceB, pieceC].map(p =>
  nextEventsByLevel(datedLines(p), { today: TODAY, kind: 'game' })
    .find(e => e.level.includes('Varsity'))?.lines.join('|')
)).size, 2)

console.log('\n— eventsInRange: the week that denied its own games —\n')

/* Reported from production: "are there any volleyball matches next week" answered
 * "next week (August 17-23) has no volleyball matches listed" while Palmer Ridge
 * played Varsity, JV and C-Squad on 20 August. The lines were in the corpus and
 * matched the event rule; the practices from 17-19 August came through.
 *
 * The list was sorted as text and cut at sixty. GoBound's scrape writes a line
 * starting with the date; the ical documents start theirs with the level tag, and
 * `[` sorts after every digit — so a week of practices from the scrape filled the
 * cap and every level-tagged game fell off the end. This fixture is that week. */
const WEEK = [
  // The scrape aggregate: every team's practices, one line each, date-first.
  ...['17', '18', '19', '20', '21'].flatMap(day =>
    ['Football', 'Soccer', 'Basketball', 'Cross Country', 'Softball', 'Tennis', 'Golf', 'Wrestling',
     'Volleyball', 'Cheer', 'Dance', 'Track'].map(sport =>
      `2026-08-${day} (Monday) 3:30 PM–5:30 PM — ${sport} Practice @ North Campus`)),
  // The ical documents: the games, behind their level tags.
  '[Volleyball Varsity (Girls)] 2026-08-20 (Thursday) 6:00 PM–7:30 PM: TCA vs Palmer Ridge @ Main Gym',
  '[Volleyball JV (Girls)] 2026-08-20 (Thursday) 4:30 PM–6:00 PM: TCA vs Palmer Ridge @ Main Gym',
  '[Volleyball C-Squad (Girls)] 2026-08-20 (Thursday) 3:00 PM–4:30 PM: TCA vs Palmer Ridge @ Aux Gym',
].join('\n')

const RANGE = { from: '2026-08-17', to: '2026-08-23' }

check('the week holds 63 events', eventsInRange(WEEK, RANGE).total, 63)

// The question that failed. Narrowed to the sport, the three matches are in it.
const vb = eventsInRange(WEEK, { ...RANGE, sport: 'volleyball' })
check('a volleyball question sees only volleyball', vb.total, 8)
check('and all three Palmer Ridge matches are there',
  vb.events.filter(e => e.line.includes('Palmer Ridge')).length, 3)
checkTrue('none of them is beyond a cap of 80', vb.events.slice(0, 80).filter(e => e.line.includes('Palmer Ridge')).length === 3)

/* The ordering fault on its own: unscoped, the games must not sit below sixty
 * practices just because their lines begin with a bracket. */
const all = eventsInRange(WEEK, RANGE)
const positions = all.events.map((e, i) => [i, e.line]).filter(([, l]) => l.includes('Palmer Ridge')).map(([i]) => i)
checkTrue('the games are ordered by their date, not by their punctuation', positions.every(i => i < 60))
// Within the sport asked about, the 20th reads in clock order — C-Squad, the
// practice, JV, Varsity — which is the order a parent needs it in.
check('and the day reads in clock order',
  vb.events.filter(e => e.ymd === '2026-08-20').map(e => e.line.match(/(\d+:\d+ [AP]M)/)[1]),
  ['3:00 PM', '3:30 PM', '4:30 PM', '6:00 PM'])

// A sport with genuinely nothing that week: the empty result is the honest one,
// and it is what lets the caller say so plainly.
check('a sport with nothing in range', eventsInRange(WEEK, { ...RANGE, sport: 'lacrosse' }).total, 0)
// Events outside the range are not in it.
check('a fixture the week after is out of range',
  eventsInRange('[Volleyball Varsity (Girls)] 2026-08-25 (Tuesday) 6:00 PM: TCA vs Atlas', RANGE).total, 0)
// An all-day entry inside the range counts, so "is there school next week" works.
check('an all-day no-school day is in the week',
  eventsInRange('2026-08-21 (Friday) — No School', RANGE).total, 1)

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}\n`)
process.exit(failures ? 1 : 0)
