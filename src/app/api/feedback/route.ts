// A parent telling us an answer was wrong, or that no answer came.
//
// This is the only signal in the app that comes from a person rather than from
// the app's own measurements. The dashboard can tell you an answer hedged or
// scored badly; it cannot tell you an answer was confident and incorrect, which
// is the failure that actually matters and the one nothing else here can see.

import { getSupabaseAdmin } from '@/lib/supabase'
import { rateLimit, tooManyRequests } from '@/lib/rate-limit'

export const maxDuration = 15

const REASONS = new Set(['wrong', 'incomplete', 'no-answer', 'other'])

const MAX_QUERY = 500
const MAX_ANSWER = 4_000
const MAX_NOTE = 1_000

// Set on the first insert of the process, like query-log's column probe: the
// table arrives with migration 009, and between deploying this and pasting that
// migration every insert is rejected. A report is a person taking the trouble
// to tell us something, so losing one silently is worse than the alternative —
// it is logged loudly enough to notice, and the caller is never shown an error
// they can do nothing about.
let tableExists: boolean | null = null

function missingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  // 42P01 is Postgres "undefined table"; PGRST205 is PostgREST's schema-cache
  // equivalent for a table it has never seen.
  if (error.code === '42P01' || error.code === 'PGRST205') return true
  return /relation .* does not exist|could not find the table/i.test(error.message ?? '')
}

export async function POST(req: Request) {
  // A report costs one small row, so this is generous — but it is still an
  // unauthenticated write, and the ceiling is what stops a script filling the
  // table faster than anyone can read it.
  const limit = await rateLimit(req, { name: 'feedback', limit: 10, windowMs: 60_000, shared: false })
  if (!limit.ok) return tooManyRequests(limit, 'Thanks — that came through already.')

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { reason, query, answer, note } = body as Record<string, unknown>
  if (typeof reason !== 'string' || !REASONS.has(reason)) {
    return Response.json({ error: 'Unknown reason' }, { status: 400 })
  }

  const str = (v: unknown, max: number) =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null

  const { error } = await getSupabaseAdmin().from('query_feedback').insert({
    reason,
    query: str(query, MAX_QUERY),
    answer: str(answer, MAX_ANSWER),
    note: str(note, MAX_NOTE),
    build_id: process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev',
  })

  if (error) {
    if (missingTable(error)) {
      if (tableExists !== false) {
        tableExists = false
        console.error(
          'query_feedback does not exist — apply supabase/migrations/009_query_feedback.sql. ' +
            'Reports are being accepted and DISCARDED until then.'
        )
      }
    } else {
      console.error('query_feedback insert failed:', error.message)
    }
    // The person reporting can do nothing about either case, and telling them
    // it failed would only discourage the next report. It is logged instead.
    return Response.json({ ok: true, stored: false })
  }

  tableExists = true
  return Response.json({ ok: true, stored: true })
}
