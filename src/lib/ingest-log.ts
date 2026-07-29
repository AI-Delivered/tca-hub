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

// Set on the first insert of the process. The table arrives with migration 010,
// and until it is applied every insert is rejected — which must not turn a
// working ingest into a failing one.
let tableExists: boolean | null = null

function missingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  if (error.code === '42P01' || error.code === 'PGRST205') return true
  return /relation .* does not exist|could not find the table/i.test(error.message ?? '')
}

/** Vercel sets this header on scheduled invocations; anything else is by hand. */
function triggerOf(req: Request): string {
  return req.headers.get('x-vercel-cron') === '1' ? 'cron' : 'manual'
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
