#!/usr/bin/env node
// Hunt for the app confidently denying something the corpus actually contains.
//
// check-answers.mjs is a regression net: ten questions whose answers we already
// know, guarding bugs we already found. It cannot find a new *class* of
// failure. This can, because it does not start from a list of questions — it
// starts from the corpus and works outward.
//
// The failure it hunts is the one that nearly ended the project: asked whether
// there was football practice next week, the app said there was none, with five
// practices sitting in its own retrieved context. A wrong time is a small
// problem — a parent notices and checks. A confident "no" is a large one,
// because a parent believes it and stops looking.
//
// How it stays cheap:
//   - Questions are generated from corpus text by pattern matching, not by a
//     model. Zero tokens.
//   - Answers are judged by regex, not by a model. Zero tokens.
//   - The only spend is the /api/search calls, capped by --limit.
//   - --dry prints the questions and spends nothing at all.
//
// And it is why generating from the corpus matters: every question here is
// built from a fact that is provably in the corpus, so a denial is not a
// judgement call about whether the app *should* have known. It knew.
//
//   node scripts/find-denials.mjs --dry              # free: show the questions
//   node scripts/find-denials.mjs --limit 12         # against production
//   node scripts/find-denials.mjs http://localhost:3000 --limit 20
//
// Exit 1 if any unwarranted denial is found.

import { loadEnv, corpus, ask, costSince } from './lib/ask.mjs'
import { judge } from './lib/denial-judge.mjs'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : argv[i + 1]
}
const BASE = argv.find(a => a.startsWith('http')) ?? 'https://tca-hub.vercel.app'
const LIMIT = Number(flag('--limit', 12))
const SEED = Number(flag('--seed', 20260803))
const DRY = argv.includes('--dry')

/* Deterministic shuffle. A finding has to be reproducible — "run it again with
 * --seed 20260803" needs to produce the same questions, or a fix cannot be
 * verified against the failure that prompted it. */
function shuffle(items, seed) {
  let s = seed >>> 0
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/* Placeholders the source documents use for information they do not carry. A
 * question generated from one of these would be a trap: the app would be right
 * to say it is not listed, and we would log a false finding. */
const UNKNOWN = /^\s*(\[?not (specified|listed|available|provided)\]?|n\/?a|tbd|tba|-+|none)\s*$/i
const isKnown = v => Boolean(v) && !UNKNOWN.test(v) && v.trim().length > 1

/** Surname, which is what an answer is most likely to carry. */
const surname = name => {
  const parts = String(name).replace(/\([^)]*\)/g, '').trim().split(/\s+/).filter(w => !/^(mr|mrs|ms|dr|coach|miss)\.?$/i.test(w))
  return parts[parts.length - 1]?.replace(/[^\w'-]/g, '') ?? ''
}

// ---------------------------------------------------------------- extraction

/** Facts: {kind, question, expect[], source, why} — expect entries are OR'd. */
function extractStaff(chunk) {
  const out = []
  const campus = chunk.content.match(/^(.+?) Staff \(\d+ staff members?\):/m)?.[1]
  if (!campus) return out

  // Roles held by exactly one person on this campus. A shared role ("2nd Grade
  // Teacher", often several) would make a correct answer naming a different
  // teacher look like a miss.
  const byRole = new Map()
  for (const m of chunk.content.matchAll(/^\s{2,}([^:\n]{3,60}):\s*(.+)$/gm)) {
    const role = m[1].trim(), name = m[2].trim()
    if (!isKnown(name)) continue
    byRole.set(role, byRole.has(role) ? null : name)
  }
  for (const [role, name] of byRole) {
    if (!name || !surname(name)) continue
    out.push({
      kind: 'staff',
      question: `who is the ${role.toLowerCase()} at ${campus}?`,
      expect: [surname(name)],
      source: chunk.url,
      why: `${campus} directory lists ${name}`,
    })
  }
  return out
}

function extractCoaches(chunk) {
  const out = []
  for (const m of chunk.content.matchAll(/^(.+?) — (?:Head Coach|Athletic Director) ([^.\n]+?)\.\s*Email:/gm)) {
    const sport = m[1].trim(), name = m[2].trim()
    if (!surname(name)) continue
    out.push({
      kind: 'coach',
      question: `who is the ${sport.toLowerCase()} coach and how do I contact them?`,
      expect: [surname(name)],
      source: chunk.url,
      why: `curated contacts list ${name}`,
    })
  }
  return out
}

function extractClubs(chunk) {
  const out = []
  /* The clubs PDF is markdown-ish:
   *   **French Honor Society**
   *   - Meeting Day/Time/Location: Wednesdays at Lunch, Room 1101
   *   - Sponsor/Email: Mr. Kueck / Jkueck@tcatitans.org           */
  for (const m of chunk.content.matchAll(/\*\*([^*\n]{3,60})\*\*\s*\n((?:\s*-[^\n]*\n?){1,4})/g)) {
    const club = m[1].trim(), block = m[2]
    if (/^(societies|clubs|organizations)/i.test(club)) continue

    /* Existence is the purest probe for this failure class, and the cheapest
     * fact to be sure of: the club is named in a school document, so "TCA does
     * not have that" is wrong no matter what else the answer says. */
    out.push({
      kind: 'club-exists',
      question: `does TCA high school have a ${club}?`,
      expect: [club.split(/\s+/)[0]],
      mode: 'existence', // the name is echoed inside denials — see denial-judge
      source: chunk.url,
      why: 'listed in the HS student organizations document',
    })

    const sponsor = block.match(/Sponsor\/Email:\s*([^\n/]+?)\s*\//)?.[1]
    if (isKnown(sponsor) && surname(sponsor)) {
      out.push({
        kind: 'club-sponsor',
        question: `who is the sponsor of ${club} at TCA?`,
        expect: [surname(sponsor)],
        source: chunk.url,
        why: `document lists ${sponsor.trim()}`,
      })
    }

    const meets = block.match(/Meeting Day\/Time\/Location:\s*([^\n]+)/)?.[1]
    if (isKnown(meets)) {
      // Any distinctive token from the meeting string counts — day, room or time.
      const tokens = [...meets.matchAll(/\b(Mondays?|Tuesdays?|Wednesdays?|Thursdays?|Fridays?|Room\s*\d+|\d{1,2}:\d{2})/gi)].map(t => t[0])
      if (tokens.length) {
        out.push({
          kind: 'club-meeting',
          question: `when does ${club} meet at TCA?`,
          expect: tokens,
          source: chunk.url,
          why: `document says: ${meets.trim().slice(0, 60)}`,
        })
      }
    }
  }
  return out
}

// ----------------------------------------------------------------- judgement

// ---------------------------------------------------------------------- main

const env = loadEnv()
const db = corpus(env)

const [staffRows, curatedRows, clubRows] = await Promise.all([
  db.selectAll('page_chunks', 'url=ilike.*staff-directory*&select=url,content'),
  db.selectAll('page_chunks', 'url=ilike.*curated*&select=url,content'),
  db.selectAll('page_chunks', 'content=ilike.*Sponsor/Email*&select=url,content'),
])

const facts = [
  ...staffRows.flatMap(extractStaff),
  ...curatedRows.flatMap(extractCoaches),
  ...clubRows.flatMap(extractClubs),
]

// De-duplicate: the same club appears in several overlapping chunks.
const seen = new Set()
const unique = facts.filter(f => !seen.has(f.question) && seen.add(f.question))

const byKind = unique.reduce((m, f) => ((m[f.kind] = (m[f.kind] ?? 0) + 1), m), {})
console.log(`corpus → ${unique.length} checkable facts ${JSON.stringify(byKind)}`)

/* Spread the sample across fact kinds rather than taking the first N of a
 * shuffle. Staff directories produce far more facts than anything else, so an
 * unweighted sample is mostly one question shape and would miss whole
 * categories of failure. */
const pools = shuffle(unique, SEED).reduce((m, f) => ((m[f.kind] ??= []).push(f), m), {})
const kinds = Object.keys(pools)
const chosen = []
for (let i = 0; chosen.length < Math.min(LIMIT, unique.length); i++) {
  const pool = pools[kinds[i % kinds.length]]
  if (pool?.length) chosen.push(pool.shift())
  else if (kinds.every(k => !pools[k].length)) break
}

if (DRY) {
  console.log(`\n--dry: ${chosen.length} questions, no API calls, no cost\n`)
  chosen.forEach((f, i) => {
    console.log(`${String(i + 1).padStart(3)}. [${f.kind}] ${f.question}`)
    console.log(`     expect ${JSON.stringify(f.expect)} — ${f.why}`)
  })
  process.exit(0)
}

const started = new Date().toISOString()
console.log(`\nasking ${BASE} — ${chosen.length} questions, ~${Math.ceil(chosen.length * 3.8 / 60)} min\n`)

const findings = []
for (const [i, fact] of chosen.entries()) {
  const { answer, error } = await ask(BASE, fact.question)
  const { verdict, severity } = judge(answer, fact)
  const tag = verdict === 'DENIED' ? 'DENIED' : verdict
  console.log(`${String(i + 1).padStart(3)}. ${tag.padEnd(12)} ${fact.question}`)
  if (verdict !== 'ok') {
    console.log(`     ${severity ?? error ?? ''}`)
    console.log(`     corpus says: ${fact.why}`)
    console.log(`     answered:    ${answer.slice(0, 200)}`)
    console.log(`     source:      ${fact.source}`)
    if (verdict === 'DENIED') findings.push({ ...fact, answer, severity })
  }
}

const spend = await costSince(db, started)
console.log(`\n${chosen.length - findings.length}/${chosen.length} clean — ${findings.length} unwarranted denial(s)`)
console.log(`cost: ${spend.queries} logged queries, ${spend.tokensIn.toLocaleString()} in / ${spend.tokensOut.toLocaleString()} out, ~$${spend.usd.toFixed(3)}`)

if (findings.length) {
  console.log(`\nreproduce: node scripts/find-denials.mjs ${BASE} --seed ${SEED} --limit ${LIMIT}`)
}
process.exit(findings.length ? 1 : 0)
