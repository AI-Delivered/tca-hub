import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isCrawlAuthorized } from '@/lib/auth'
import { withIngestLog } from '@/lib/ingest-log'
import { runAudit, type Chunk, type LoggedAnswer } from '@/lib/audit'

export const maxDuration = 300

/* Reading the whole corpus, in pages, because the point is to miss nothing.
 *
 * PostgREST caps a response, so a bare select returns the first page and looks
 * complete — the same shape of mistake this route exists to find. */
const PAGE = 1000
const MAX_CHUNKS = 20_000

/** Answers from the last day: enough to see a pattern, small enough to stay cheap. */
const ANSWER_WINDOW_HOURS = 24
const MAX_ANSWERS = 500

async function run(req: NextRequest) {
  if (!isCrawlAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = getSupabaseAdmin()
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' })
  const notes: string[] = []

  const chunks: Chunk[] = []
  for (let from = 0; from < MAX_CHUNKS; from += PAGE) {
    const { data, error } = await supabase
      .from('page_chunks')
      .select('url, title, content')
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) {
      // A partial read would report invariants holding over the part it managed to
      // read, which is worse than saying the audit could not run.
      return NextResponse.json({ error: `could not read page_chunks: ${error.message}` }, { status: 502 })
    }
    chunks.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }
  if (chunks.length >= MAX_CHUNKS) notes.push(`corpus reached the ${MAX_CHUNKS} row ceiling — audit may be partial`)

  /* Answers are a bonus, not a precondition.
   *
   * `answer` arrives with migration 007, and a database that has not had it applied
   * rejects the select outright. The corpus checks are the valuable half and must
   * not be lost to that. */
  let answers: LoggedAnswer[] = []
  const since = new Date(Date.now() - ANSWER_WINDOW_HOURS * 60 * 60 * 1000).toISOString()
  const { data: answerRows, error: answerError } = await supabase
    .from('query_log')
    .select('query, answer, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(MAX_ANSWERS)
  if (answerError) notes.push(`answers not audited: ${answerError.message}`)
  else answers = (answerRows ?? [])
    .filter(r => typeof r.answer === 'string' && r.answer.trim())
    .map(r => ({ query: String(r.query ?? ''), answer: String(r.answer), created_at: String(r.created_at ?? '') }))

  const report = runAudit({ chunks, answers, today, notes })

  /* `errors` is what the dashboard reads off any ingest run, so a corpus that
   * violates an invariant shows up in the same column as a failed insert — which
   * is the point. A clean run is a row saying so, which is also worth having: it
   * is the difference between "no problems" and "nobody looked". */
  return NextResponse.json(report)
}

function handler(req: NextRequest) {
  return withIngestLog(req, '/api/audit', () => run(req))
}

export const GET = handler
