#!/usr/bin/env node
// Query smoke tests — asks the real questions a TCA parent asks and checks the
// answers against invariants that shouldn't ever break, so regressions surface
// here instead of on someone's phone.
//
//   node scripts/smoke-queries.mjs                    # against localhost:3000
//   node scripts/smoke-queries.mjs https://tca-hub.vercel.app
//   node scripts/smoke-queries.mjs --only staff       # one section
//
// Exit code is non-zero if any check fails, so CI can gate on it.

const BASE = process.argv.find(a => a.startsWith('http')) ?? 'http://localhost:3000'
const onlyIdx = process.argv.indexOf('--only')
const ONLY = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null
const CONCURRENCY = 4

// Deliberately narrow: an answer that says "TCA doesn't have a single front
// office" is answering the question, not failing it. Only phrases that mean
// "the context didn't contain this" count.
const NOT_FOUND = /(don'?t|do not|doesn'?t) (have|see) (that|specific|any|the specific|information|info|details)|couldn'?t find|not in (what I have|the context|my)|don'?t see .*(in what I have|in the context)|no (information|details) (on|about|for)/i

// Invariants every answer must satisfy, regardless of the question.
const UNIVERSAL = [
  {
    name: 'answers something',
    check: r => r.answer.trim().length > 0 || 'empty answer',
  },
  {
    name: 'no follow-up question (system prompt HARD RULE)',
    check: r => !/\?\s*$/.test(r.answer.trim()) || `ends with a question: "${r.answer.trim().slice(-80)}"`,
  },
  {
    name: 'no duplicate people in staff cards',
    check: r => {
      const names = r.cards.map(c => c.name.toLowerCase())
      const dupes = names.filter((n, i) => names.indexOf(n) !== i)
      return dupes.length === 0 || `duplicated: ${[...new Set(dupes)].join(', ')}`
    },
  },
  {
    name: 'no staff cards next to a "we don\'t know" answer',
    check: r => !(r.cards.length > 0 && NOT_FOUND.test(r.answer)) ||
      `${r.cards.length} cards shown but answer says it has nothing: "${r.answer.slice(0, 90)}"`,
  },
  {
    // The card set is derived from the answer, so any card the answer didn't
    // name means the derivation drifted.
    name: 'every card is someone the answer named',
    check: r => {
      const unnamed = r.cards.filter(c => {
        const last = c.name.trim().split(/\s+/).pop() ?? ''
        return !r.answer.toLowerCase().includes(c.name.toLowerCase()) &&
          !new RegExp(`\\b(mr|mrs|ms|miss|dr|coach)\\.?\\s+${last}\\b`, 'i').test(r.answer)
      })
      return unnamed.length === 0 || `not mentioned in the answer: ${unnamed.map(c => c.name).join(', ')}`
    },
  },
  {
    name: 'every card has a photo',
    check: r => r.cards.every(c => c.photo) || 'card without a photo URL',
  },
  {
    name: 'no calendar sources from a past school year',
    check: r => {
      const now = new Date()
      const stale = r.sources.filter(s => {
        const m = `${s.title} ${s.url}`.toLowerCase().match(/(january|february|march|april|may|june|july|august|september|october|november|december)[\s—-]+(20\d{2})/)
        if (!m) return false
        const months = ['january','february','march','april','may','june','july','august','september','october','november','december']
        const mi = months.indexOf(m[1]), yr = Number(m[2])
        return yr < now.getFullYear() || (yr === now.getFullYear() && mi < now.getMonth())
      })
      return stale.length === 0 || `stale: ${stale.map(s => s.title).join(', ')}`
    },
  },
]

// Per-question expectations. `cards` / `noCards` / `sourceLike` / `answerLike`
// are all optional — a question with none of them is still run through UNIVERSAL.
const CASES = [
  // ---- staff ---------------------------------------------------------------
  { section: 'staff', q: 'Who is the principal at East Elementary', cards: /amy pope/i, campus: 'East Elementary' },
  { section: 'staff', q: "Who's the middle school principal", cards: /hugh dipretore/i, campus: 'Junior High' },
  { section: 'staff', q: 'who is the JH principal', cards: /hugh dipretore/i, campus: 'Junior High' },
  { section: 'staff', q: 'who is the high school principal', campus: 'High School' },
  { section: 'staff', q: 'who is the nurse at Junior High', cards: /nurse/i, campus: 'Junior High' },
  { section: 'staff', q: 'who are the 2nd grade teachers at East', minCards: 3, campus: 'East Elementary' },
  { section: 'staff', q: 'who works at Central Elementary', minCards: 1, campus: 'Central Elementary' },
  { section: 'staff', q: "Whos the football coach", noCards: true, why: 'coaches are not in the staff directory' },
  { section: 'staff', q: 'who is the athletic director', minCards: 1, maxCards: 3, cardsNot: /band|philosophy|principal|counselor/i },
  { section: 'staff', q: 'who is the band director', minCards: 1, maxCards: 3, cardsNot: /athletic|philosophy/i },
  { section: 'staff', q: 'who is Amy Pope', cards: /amy pope/i, maxCards: 2 },
  { section: 'staff', q: 'what is the counselor email at the high school', campus: 'High School' },

  // ---- athletics -----------------------------------------------------------
  { section: 'sports', q: 'when is the next football game', sourceLike: /athletics|football|gobound/i },
  { section: 'sports', q: 'when do the football playoffs start', sourceLike: /athletics|football/i },
  { section: 'sports', q: 'when does volleyball practice start', sourceLike: /athletics|volleyball/i },
  { section: 'sports', q: 'when is the next track meet', sourceLike: /athletics|track/i },
  { section: 'sports', q: 'does TCA have a lacrosse team' },
  { section: 'sports', q: 'when are basketball tryouts', sourceLike: /athletics|basketball/i },

  // ---- calendar ------------------------------------------------------------
  { section: 'calendar', q: 'what days off does school have in October', sourceLike: /calendar/i },
  { section: 'calendar', q: 'when does school start', sourceLike: /calendar|first day|welcome|home/i },
  { section: 'calendar', q: 'is there school on Labor Day' },
  { section: 'calendar', q: 'when is fall break' },
  { section: 'calendar', q: 'when is drop off at East Elementary', sourceLike: /carpool|east/i },
  { section: 'calendar', q: 'what time does school start at the junior high' },

  // ---- questions that must NOT be hijacked to the wrong corpus -------------
  { section: 'routing', q: 'what is the attendance policy', notSourceLike: /athletics|gobound/i },
  { section: 'routing', q: 'when is the next PTO meeting', notSourceLike: /athletics — upcoming/i },
  { section: 'routing', q: 'how do I match my student to a teacher', notSourceLike: /athletics — upcoming/i },
  { section: 'routing', q: 'where is the front office', notSourceLike: /athletics/i },
  { section: 'routing', q: 'how do I order lunch', notSourceLike: /athletics/i },

  // ---- general -------------------------------------------------------------
  { section: 'general', q: 'what is the dress code' },
  { section: 'general', q: 'how do I report an absence' },
  { section: 'general', q: 'what is the school phone number' },
  { section: 'general', q: 'how do I sign up for the newsletter' },
  { section: 'general', q: 'where do I find the supply list' },
  { section: 'general', q: 'what is TCA' },
]

async function ask(query) {
  const started = Date.now()
  const res = await fetch(`${BASE}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  const out = { answer: '', sources: [], cards: [], ms: 0 }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    if (ev.type === 'text') out.answer += ev.text
    if (ev.type === 'sources') out.sources = ev.sources
    if (ev.type === 'staffCards') out.cards = ev.staffCards
    if (ev.type === 'error') out.error = ev.message
  }
  out.ms = Date.now() - started
  return out
}

function checkCase(c, r) {
  const fails = []
  for (const inv of UNIVERSAL) {
    const verdict = inv.check(r)
    if (verdict !== true) fails.push(`${inv.name}: ${verdict}`)
  }
  if (c.cards && !r.cards.some(card => c.cards.test(`${card.name} ${card.role}`)))
    fails.push(`expected a card matching ${c.cards} — got ${r.cards.map(x => x.name).join(', ') || 'none'}`)
  if (c.cardsNot && r.cards.some(card => c.cardsNot.test(`${card.name} ${card.role}`)))
    fails.push(`irrelevant cards: ${r.cards.filter(x => c.cardsNot.test(`${x.name} ${x.role}`)).map(x => `${x.name} (${x.role})`).join(', ')}`)
  if (c.noCards && r.cards.length)
    fails.push(`expected no cards (${c.why}) — got ${r.cards.map(x => x.name).join(', ')}`)
  if (c.minCards && r.cards.length < c.minCards)
    fails.push(`expected ≥${c.minCards} cards, got ${r.cards.length}`)
  if (c.maxCards && r.cards.length > c.maxCards)
    fails.push(`expected ≤${c.maxCards} cards, got ${r.cards.length} (${r.cards.map(x => x.name).join(', ')})`)
  if (c.campus && r.cards.some(card => card.campus && card.campus !== c.campus))
    fails.push(`cards from the wrong campus: ${[...new Set(r.cards.map(x => x.campus))].join(', ')} (asked about ${c.campus})`)
  if (c.sourceLike && r.sources.length && !r.sources.some(s => c.sourceLike.test(`${s.title} ${s.url}`)))
    fails.push(`no source matching ${c.sourceLike} — got ${r.sources.map(s => s.title).join(' | ') || 'none'}`)
  if (c.notSourceLike && r.sources.some(s => c.notSourceLike.test(`${s.title} ${s.url}`)))
    fails.push(`wrong corpus: ${r.sources.filter(s => c.notSourceLike.test(`${s.title} ${s.url}`)).map(s => s.title).join(', ')}`)
  if (r.error) fails.push(`stream error: ${r.error}`)
  return fails
}

const cases = ONLY ? CASES.filter(c => c.section === ONLY) : CASES
console.log(`\n  ${cases.length} questions against ${BASE}\n`)

const results = []
for (let i = 0; i < cases.length; i += CONCURRENCY) {
  const batch = cases.slice(i, i + CONCURRENCY)
  const settled = await Promise.all(batch.map(async c => {
    try {
      const r = await ask(c.q)
      return { c, fails: checkCase(c, r), ms: r.ms }
    } catch (e) {
      return { c, fails: [`request failed: ${e.message}`], ms: 0 }
    }
  }))
  for (const s of settled) {
    results.push(s)
    const mark = s.fails.length ? '✗' : '✓'
    console.log(`  ${mark} [${s.c.section}] ${s.c.q}  ${s.ms ? `(${(s.ms / 1000).toFixed(1)}s)` : ''}`)
    for (const f of s.fails) console.log(`      → ${f}`)
  }
}

const failed = results.filter(r => r.fails.length)
const slow = results.filter(r => r.ms > 8000)
console.log(`\n  ${results.length - failed.length}/${results.length} passed`)
if (slow.length) console.log(`  ${slow.length} slower than 8s: ${slow.map(s => s.c.q).join(' | ')}`)
if (failed.length) {
  console.log(`\n  FAILURES:`)
  for (const f of failed) console.log(`   - [${f.c.section}] "${f.c.q}"\n       ${f.fails.join('\n       ')}`)
}
process.exit(failed.length ? 1 : 0)
