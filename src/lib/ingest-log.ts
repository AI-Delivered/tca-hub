// Recording what an ingest run did, so the dashboard can say what changed.
//
// Every crawl route already computes a precise account of its own work and then
// hands it to whoever called it. At 5am that is Vercel's scheduler, and nobody
// reads it. This keeps a copy.
//
// Wrapped around the response rather than bolted into each route's body: a
// route returns exactly what it returned before, and the log is a side effect
// of returning it. That way there is no second place to keep in sync when a
// route starts reporting something new.

import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { secretMatches } from '@/lib/auth'

// Set on the first insert of the process. The table arrives with migration 010,
// and until it is applied every insert is rejected — which must not turn a
// working ingest into a failing one.
let tableExists: boolean | null = null

function missingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  if (error.code === '42P01' || error.code === 'PGRST205') return true
  return /relation .* does not exist|could not find the table/i.test(error.message ?? '')
}

/* How this run was invoked.
 *
 * This checked for the `x-vercel-cron: 1` header, and got it exactly backwards.
 * Once CRON_SECRET is set, Vercel authenticates a scheduled run with
 * `Authorization: Bearer $CRON_SECRET` and does not send that header — so every
 * real cron run was recorded as "manual", while the only row ever labelled
 * "cron" was a request I sent by hand with the header spoofed to prove the
 * routes were unauthenticated. The label meant precisely the opposite of what
 * it claimed, on the one distinction the panel exists to draw.
 *
 * The bearer secret is what actually identifies Vercel's scheduler now, so that
 * is what this reads. The header is kept as a fallback for the case the secret
 * is unset, where it is the only signal available — and where, as established,
 * it proves nothing.
 */
function triggerOf(req: Request): string {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer /i, '')
  if (secretMatches(bearer, process.env.CRON_SECRET)) return 'cron'
  if (!process.env.CRON_SECRET && req.headers.get('x-vercel-cron') === '1') return 'cron'
  return 'manual'
}

/**
 * Pull the headline numbers out of a route's summary.
 *
 * Each route names things differently — chunksIndexed, chunksInserted,
 * indexed, inserted — because each is doing a different job. Rather than force
 * them into one vocabulary, this reads whichever it finds; the full summary is
 * stored regardless, so nothing is lost by guessing wrong here.
 */
function headline(summary: Record<string, unknown>): { items: number | null; errors: number | null } {
  const num = (...keys: string[]): number | null => {
    for (const k of keys) {
      const v = summary[k]
      if (typeof v === 'number') return v
    }
    return null
  }
  return {
    items: num('chunksIndexed', 'chunksInserted', 'indexed', 'inserted', 'chunks'),
    errors: num('errors', 'errorCount'),
  }
}

/**
 * Runs `work`, returns its response untouched, and records what it reported.
 *
 * Never throws on its own account: a failed log must not fail an ingest.
 */
export async function withIngestLog(
  req: Request,
  route: string,
  work: () => Promise<NextResponse>
): Promise<NextResponse> {
  const startedAt = Date.now()
  const res = await work()

  // Read the body without consuming the caller's copy.
  let summary: Record<string, unknown> | null = null
  try {
    summary = (await res.clone().json()) as Record<string, unknown>
  } catch {
    // Not JSON — an error page, a redirect. Nothing worth recording.
  }

  if (summary && typeof summary === 'object') {
    const { items, errors } = headline(summary)
    const { error } = await getSupabaseAdmin().from('ingest_runs').insert({
      route,
      trigger: triggerOf(req),
      duration_ms: Date.now() - startedAt,
      items,
      errors,
      summary,
    })
    if (error) {
      if (missingTable(error)) {
        if (tableExists !== false) {
          tableExists = false
          console.warn(
            'ingest_runs does not exist — apply supabase/migrations/010_ingest_runs.sql. ' +
              'Ingest is unaffected; the dashboard just cannot show what changed.'
          )
        }
      } else {
        console.error('ingest_runs insert failed:', error.message)
      }
    } else {
      tableExists = true
    }
  }

  return res
}
