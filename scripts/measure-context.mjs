#!/usr/bin/env node
// Measures what each question costs to answer, and — crucially — checks that the
// fact needed to answer it is still in the context. Retrieval-only: this never
// calls the answer model, so it costs nothing to run and can be used to tune
// context size while the Anthropic account is empty.
//
//   node scripts/measure-context.mjs                    # measure + assert
//   node scripts/measure-context.mjs --save before.json # snapshot for comparison
//   node scripts/measure-context.mjs --compare before.json
//
// `mustContain` is the answer-bearing string a parent's question depends on. If
// a trim drops it, the answer degrades — that's a failure, no LLM needed to see it.

import fs from 'fs'

const BASE = process.argv.find(a => a.startsWith('http')) ?? 'http://localhost:3000'
const SECRET = (fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  .split('\n').find(l => l.startsWith('CRAWL_SECRET=')) ?? '').split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '')

const saveIdx = process.argv.indexOf('--save')
const cmpIdx = process.argv.indexOf('--compare')

// Haiku pricing, input side — the dominant cost at ~28k tokens per question.
const PER_MTOK_IN = 1.0

const CASES = [
  { q: 'who is the principal at East Elementary', mustContain: ['Amy Pope'] },
  { q: "Who's the middle school principal", mustContain: ['Hugh DiPretore'] },
  { q: 'who is the nurse at Junior High', mustContain: ['Tagliere'] },
  { q: 'who are the 2nd grade teachers at East', mustContain: ['Margaret Graham', 'Teal Johnson', 'Mikaela Love', 'Katelyn Tate', 'Rebecca Wade'] },
  { q: 'who is the athletic director', mustContain: ['Darron Mitchell'] },
  { q: 'what is the counselor email at the high school', mustContain: ['Counselor'] },
  // For schedules, presence of the word isn't enough — the context has to still
  // carry a real dated event for that sport, or the answer has nothing to cite.
  { q: 'when is the next football game', mustContain: ['Football'], mustMatch: [/\[Football[^\]]*\][^\n]*20\d{2}/] },
  { q: 'when do the football playoffs start', mustContain: ['Football'], mustMatch: [/\[Football[^\]]*\][^\n]*20\d{2}/] },
  { q: 'when does volleyball practice start', mustContain: ['Volleyball'], mustMatch: [/Volleyball[^\n]*20\d{2}/] },
  { q: 'when is the next track meet', mustContain: ['Track'], mustMatch: [/Track[^\n]*20\d{2}/] },
  { q: 'when is the next game', mustMatch: [/20\d{2}/] },
  { q: 'who are the 5th grade teachers at North', mustContain: ['5th Grade Teacher'] },
  { q: 'what days off does school have in October', mustContain: ['October 2026'] },
  { q: 'when does school start', mustContain: [] },
  { q: 'is there school on Labor Day', mustContain: [] },
  { q: 'when is drop off at East Elementary', mustContain: ['Carpool'] },
  { q: 'what is the attendance policy', mustContain: [] },
  { q: 'when is the next PTO meeting', mustContain: ['PTO'] },
  { q: 'how do I report an absence', mustContain: [] },
  { q: 'what is the dress code', mustContain: [] },
  { q: 'where do I find the supply list', mustContain: [] },
  { q: 'what is TCA', mustContain: [] },
]

async function measure(q) {
  const res = await fetch(`${BASE}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-crawl-secret': SECRET },
    body: JSON.stringify({ query: q, debug: true }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

const rows = []
for (const c of CASES) {
  try {
    const d = await measure(c.q)
    const missing = (c.mustContain ?? []).filter(s => !d.context.toLowerCase().includes(s.toLowerCase()))
      .concat((c.mustMatch ?? []).filter(re => !re.test(d.context)).map(re => `pattern ${re}`))
    rows.push({ q: c.q, tokens: d.estInputTokens, chunks: d.chunkCount, chars: d.contextChars, missing,
      biggest: d.chunks.slice().sort((a, b) => b.chars - a.chars)[0] })
  } catch (e) {
    rows.push({ q: c.q, error: e.message, tokens: 0, chunks: 0, chars: 0, missing: [] })
  }
}

const total = rows.reduce((s, r) => s + r.tokens, 0)
const avg = Math.round(total / rows.length)
const broken = rows.filter(r => r.missing.length || r.error)

console.log(`\n  ${rows.length} questions against ${BASE}  (retrieval only — no answer tokens spent)\n`)
for (const r of rows.sort((a, b) => b.tokens - a.tokens)) {
  const flag = r.error ? `ERROR ${r.error}` : r.missing.length ? `MISSING: ${r.missing.join(', ')}` : ''
  console.log(`  ${String(r.tokens).padStart(6)} tok  ${String(r.chunks).padStart(3)} chunks  ${r.q.slice(0, 44).padEnd(46)} ${flag}`)
  if (r.biggest && r.biggest.chars > 6000) console.log(`         └─ largest chunk: ${r.biggest.chars} chars — ${r.biggest.title}`)
}
console.log(`\n  average ${avg.toLocaleString()} input tokens/question  ≈ $${(avg / 1e6 * PER_MTOK_IN).toFixed(4)} each, $${(avg / 1e6 * PER_MTOK_IN * 1000).toFixed(2)} per 1,000 questions`)
console.log(`  ${broken.length ? `${broken.length} QUESTIONS LOST THEIR ANSWER-BEARING FACT` : 'every answer-bearing fact still present'}`)

if (saveIdx > -1) {
  fs.writeFileSync(process.argv[saveIdx + 1], JSON.stringify({ avg, rows }, null, 2))
  console.log(`  saved -> ${process.argv[saveIdx + 1]}`)
}

if (cmpIdx > -1) {
  const before = JSON.parse(fs.readFileSync(process.argv[cmpIdx + 1], 'utf8'))
  const byQ = new Map(before.rows.map(r => [r.q, r]))
  console.log(`\n  BEFORE ${before.avg.toLocaleString()} tok  ->  AFTER ${avg.toLocaleString()} tok   (${((1 - avg / before.avg) * 100).toFixed(0)}% cheaper)`)
  for (const r of rows) {
    const b = byQ.get(r.q)
    if (!b) continue
    const delta = b.tokens ? ((1 - r.tokens / b.tokens) * 100).toFixed(0) : '0'
    console.log(`    ${String(b.tokens).padStart(6)} -> ${String(r.tokens).padStart(6)}  (${String(delta).padStart(3)}% off)  ${r.q.slice(0, 50)}`)
  }
}

process.exit(broken.length ? 1 : 0)
