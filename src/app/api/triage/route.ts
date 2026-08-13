import { NextRequest, NextResponse } from 'next/server'
import { getCache } from '@vercel/functions'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isCrawlAuthorized } from '@/lib/auth'
import { withIngestLog } from '@/lib/ingest-log'
import { answerCacheKey } from '@/lib/query-key'
import { datesIn } from '@/lib/schedule'
import { unansweredOrFilter } from '@/lib/unanswered'
import { triageBug, summarise, type ReportedBug, type Triage, type Verdict } from '@/lib/triage'

export const maxDuration = 300

/* Paced, because this route is a client of its own app.
 *
 * /api/search allows 20 requests a minute per identity and every question here
 * costs two of them. check-answers.mjs learned this the hard way: unpaced, it got
 * 429s and reported four empty answers as content failures, which is a checker
 * inventing bugs. Eight reports per run at two runs each is sixteen requests in
 * about a minute, comfortably under, and the backlog drains over a few days rather
 * than in one go.
 */
const BUGS_PER_RUN = 8
const RUNS_PER_BUG = 2
const PACE_MS = 3_800

/** Self-reported failures to pick up alongside the human ones. */
const SELF_REPORTED_PER_RUN = 4
const SELF_REPORT_WINDOW_HOURS = 48

const PAGE = 1000
const MAX_CHUNKS = 20_000

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Ask the app a question the way a browser does, with the answer cache bypassed. */
async function ask(baseUrl: string, query: string): Promise<string> {
  await sleep(PACE_MS)
  try {
    const res = await fetch(`${baseUrl}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `debug: true` is what skips the cache — triage has to see what retrieval
      // and generation do now, not read back the answer that was complained about.
      body: JSON.stringify({ query, debug: true }),
    })
    if (!res.ok) return ''
    let answer = ''
    for (const line of (await res.text()).split('\n')) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        if (event.type === 'text') answer += event.text
      } catch { /* a partial line at the end of the stream */ }
    }
    return answer.trim()
  } catch {
    return ''
  }
}

async function run(req: NextRequest) {
  if (!isCrawlAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = getSupabaseAdmin()
  const baseUrl = req.nextUrl.origin
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' })
  const notes: string[] = []

  /* Reports from people first, then the app's own admissions.
   *
   * A parent took the trouble to send theirs, and it is the only signal here that
   * can see an answer that was confident and wrong. */
  let reports: Array<{ id: number; reason: string; query: string; answer: string | null }> = []
  const { data: feedbackRows, error: feedbackError } = await supabase
    .from('query_feedback')
    .select('id, reason, query, answer')
    .is('triaged_at', null)
    .order('created_at', { ascending: false })
    .limit(BUGS_PER_RUN)
  if (feedbackError) {
    // Migration 012 adds triaged_at; until it is applied this route still has
    // useful work to do on the self-reported half, so it says so and carries on.
    notes.push(`feedback not triaged: ${feedbackError.message}`)
  } else {
    reports = (feedbackRows ?? []).map(r => ({
      id: Number(r.id), reason: String(r.reason ?? 'other'),
      query: String(r.query ?? ''), answer: r.answer ? String(r.answer) : null,
    })).filter(r => r.query.trim())
  }

  /* The app's own filed bugs: answers that told a parent we do not have this.
   *
   * Deduplicated by question, because one gap produces the same complaint from
   * everyone who asks, and triaging it eight times is eight generations spent to
   * learn one thing. */
  const bugs: ReportedBug[] = reports.map(r => ({ reason: r.reason, query: r.query, answer: r.answer }))
  const roomLeft = Math.max(0, BUGS_PER_RUN - bugs.length)
  if (roomLeft > 0) {
    const since = new Date(Date.now() - SELF_REPORT_WINDOW_HOURS * 60 * 60 * 1000).toISOString()
    const { data: silentRows, error: silentError } = await supabase
      .from('query_log')
      .select('query, answer')
      .gte('created_at', since)
      .or(unansweredOrFilter('answer'))
      .order('created_at', { ascending: false })
      .limit(60)
    if (silentError) notes.push(`self-reported gaps not read: ${silentError.message}`)
    else {
      const seen = new Set(bugs.map(b => b.query.toLowerCase().trim()))
      for (const row of silentRows ?? []) {
        const query = String(row.query ?? '').trim()
        const key = query.toLowerCase()
        if (!query || seen.has(key)) continue
        seen.add(key)
        bugs.push({ reason: 'self', query, answer: row.answer ? String(row.answer) : null })
        if (bugs.length >= Math.min(BUGS_PER_RUN, reports.length + SELF_REPORTED_PER_RUN + roomLeft)) break
      }
    }
  }

  if (!bugs.length) {
    return NextResponse.json({ evaluated: 0, resolved: 0, needHuman: 0, byVerdict: {}, results: [], notes })
  }

  /* Every date the corpus holds, for deciding whether an answer read a date or
   * produced one. Read in pages: a bare select returns the first page and looks
   * complete, which is the mistake half this branch was about. */
  const corpusDates = new Set<string>()
  for (let from = 0; from < MAX_CHUNKS; from += PAGE) {
    const { data, error } = await supabase
      .from('page_chunks').select('content').order('id').range(from, from + PAGE - 1)
    if (error) {
      notes.push(`corpus dates unavailable: ${error.message} — unsupported-date not checked`)
      break
    }
    for (const row of data ?? []) for (const d of datesIn(String(row.content ?? ''))) corpusDates.add(d.ymd)
    if (!data || data.length < PAGE) break
  }

  const cache = getCache()
  const results: Array<{ query: string; reason: string; verdict: Verdict; detail: string; needsHuman: boolean; acted: string[] }> = []

  for (const [i, bug] of bugs.entries()) {
    const freshAnswers: string[] = []
    for (let run = 0; run < RUNS_PER_BUG; run++) freshAnswers.push(await ask(baseUrl, bug.query))

    const triage: Triage = triageBug({ bug, freshAnswers, corpusDates, today })

    /* The one fix that is safe to apply without a person.
     *
     * A cached answer carrying a fault is served to everyone who asks the same
     * question until it expires, so dropping that one entry stops the bleeding and
     * costs a single regeneration. Nothing else here writes: no corpus edits, no
     * code changes, no rewriting what a parent was told. */
    const acted: string[] = []
    if (triage.actions.includes('expire-cached-answer')) {
      try {
        await cache.delete(answerCacheKey(bug.query, today))
        acted.push('expired the cached answer')
      } catch (e) {
        notes.push(`cache delete failed for "${bug.query.slice(0, 40)}": ${e instanceof Error ? e.message : e}`)
      }
    }

    results.push({
      query: bug.query, reason: bug.reason,
      verdict: triage.verdict, detail: triage.detail, needsHuman: triage.needsHuman, acted,
    })

    // Human reports get their verdict written back so the next run skips them and
    // the untriaged list is what has genuinely not been looked at.
    const report = reports[i]
    if (report && !feedbackError) {
      const { error } = await supabase
        .from('query_feedback')
        .update({
          triaged_at: new Date().toISOString(),
          verdict: triage.verdict,
          verdict_detail: { detail: triage.detail, needsHuman: triage.needsHuman, acted, answers: freshAnswers },
        })
        .eq('id', report.id)
      if (error) notes.push(`verdict not saved for feedback ${report.id}: ${error.message}`)
    }
  }

  /* `errors` is the column the dashboard reads off any run, and a report that
   * needs a human is the thing this route exists to surface — so that count goes
   * there rather than a count of crashes. A quiet run means the backlog was
   * evaluated and nothing needs anybody. */
  const summary = summarise(results)
  return NextResponse.json({ ...summary, errors: summary.needHuman, results, notes })
}

function handler(req: NextRequest) {
  return withIngestLog(req, '/api/triage', () => run(req))
}

export const GET = handler
