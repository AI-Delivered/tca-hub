#!/usr/bin/env node
// Ask the live app a set of questions with known answers, several times each,
// and report which ones it gets wrong.
//
// This exists because single-run checks kept passing on behaviour that was only
// right about half the time. "When is football practice next week" was verified
// once, shipped, and then told a parent there were no practices — with the five
// practices sitting at the top of its own retrieved context. One sample of a
// coin flip looks like a working feature.
//
//   node scripts/check-answers.mjs                     # against production
//   node scripts/check-answers.mjs http://localhost:3000
//   node scripts/check-answers.mjs http://localhost:3000 5   # 5 runs each
//
// Each case says what MUST appear and what must NOT. Keep them factual and
// specific — "3:00" rather than "the right time" — so a pass means the answer
// carried the fact, not that it sounded plausible.

const BASE = process.argv[2] ?? 'https://tca-hub.vercel.app'
const RUNS = Number(process.argv[3] ?? 3)

/** must: every entry has to appear. mustNot: none may. any: at least one. */
const CASES = [
  {
    q: 'what time does the high school day end',
    must: ['3:00'],
    mustNot: ['3:10'],
    why: 'HS ends 3:00; 3:10 is College Pathways',
  },
  {
    q: 'what time does high school start',
    must: ['7:45'],
    why: 'first period',
  },
  {
    q: 'who is the football coach',
    must: ['Rich'],
    why: 'Justin Rich, from curated athletics contacts',
  },
  {
    q: 'When is homecoming',
    must: ['25', '26'],
    why: 'game Friday the 25th AND dance Saturday the 26th — both, not one',
  },
  {
    q: 'when is fall break',
    must: ['October 12'],
    why: 'Oct 12-16, all campuses',
  },
  {
    q: 'who is the cross country coach at east elementary',
    must: ['Leiker'],
    mustNot: ['not offered', "doesn't have a cross country"],
    why: 'elementary cross country is Landsharks, not a gap',
  },
  {
    q: 'when is landsharks practice at east',
    must: ['7:10'],
    why: 'Tue/Thu 7:10-7:55am',
  },
  {
    q: 'when is the meet and greet at east elementary',
    must: ['August 18'],
    why: 'from the emailed newsletter — exists nowhere on the website',
  },
  {
    q: 'who is the junior high principal',
    must: ['DiPretore'],
    why: 'staff directory',
  },
  {
    q: 'when is the first day of school for central elementary',
    must: ['August'],
    why: 'K on the 19th, grades 1-6 on the 20th',
  },
  /* Volleyball has no TeamReach feed, so its practices come from GoBound alone
   * — the case most likely to regress if the practice rules change.
   *
   * Deliberately "the next practice" and not "practice this week". The first
   * version of this case asked about this week and asserted the answer must not
   * say there were none, which was false the day it was written: the corpus had
   * no volleyball practice in that range at all. A test that forbids the
   * correct answer trains the fix in the wrong direction — it would have
   * rewarded the model for inventing practices. */
  {
    q: 'when is the next volleyball practice?',
    must: ['August'],
    mustNot: ['not offered', "doesn't have a volleyball"],
    why: 'GoBound lists JH volleyball practices through late August',
  },
  {
    q: 'does TCA have a wrestling team?',
    mustNot: ["doesn't have", 'does not have', 'not offered'],
    why: 'thin schedule data must never become "the sport does not exist"',
  },
]

/* /api/search allows 20 requests a minute, and this suite fires more than that.
 * The first version of this script did not pace itself, got 429s, and reported
 * four empty answers as content failures — a test harness inventing bugs is
 * worse than no harness. Paced under the limit, and a 429 is called out rather
 * than counted as a wrong answer. */
const PACE_MS = 3800
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function ask(q) {
  await sleep(PACE_MS)
  const res = await fetch(`${BASE}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, debug: true }),
  })
  if (res.status === 429) return '__RATE_LIMITED__'
  let answer = ''
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.type === 'text') answer += o.text
  }
  return answer.replace(/\s+/g, ' ').trim()
}

function verdict(answer, c) {
  if (answer === '__RATE_LIMITED__') return 'rate limited — not a content failure'
  if (!answer.trim()) return 'empty response'
  const has = s => answer.toLowerCase().includes(s.toLowerCase())
  for (const m of c.must ?? []) if (!has(m)) return `missing "${m}"`
  for (const m of c.mustNot ?? []) if (has(m)) return `contains "${m}"`
  if (c.any && !c.any.some(has)) return `none of ${c.any.join(' / ')}`
  return null
}

console.log(`${BASE} — ${CASES.length} questions x ${RUNS} runs\n`)

let failed = 0
for (const c of CASES) {
  const answers = []
  for (let i = 0; i < RUNS; i++) answers.push(await ask(c.q))
  const bad = answers.map(a => verdict(a, c)).filter(Boolean)
  const pass = bad.length === 0
  if (!pass) failed++
  // Flaky is its own outcome, and the one that matters most here: an answer
  // that is right twice and wrong once is not a working answer.
  const label = pass ? 'ok  ' : bad.length === RUNS ? 'FAIL' : 'FLAKY'
  console.log(`${label.padEnd(6)} ${c.q}`)
  if (!pass) {
    console.log(`       ${bad.length}/${RUNS} bad — ${[...new Set(bad)].join('; ')}`)
    console.log(`       expected: ${c.why}`)
    console.log(`       got: ${answers[answers.length - 1].slice(0, 150)}`)
  }
}

console.log(`\n${CASES.length - failed}/${CASES.length} passing`)
process.exit(failed ? 1 : 0)
