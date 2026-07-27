// Writing a row to query_log.
//
// This exists for one reason: the columns added by migration 007 (answer,
// sources, cache_hit) live in a database that is deployed separately from this
// code. Between `git push` and someone pasting the migration into the Supabase
// SQL editor, an insert naming those columns is rejected outright — PostgREST
// validates the whole payload against its schema cache before it writes
// anything. Not "the new fields are null"; the row never lands. Query logging
// is the only record of what the app said to a parent, so losing it silently
// for a day is much worse than losing three columns.
//
// So: try the full row, and if the database says it doesn't know a column,
// drop the new fields and write the row the old shape understands. The
// decision is remembered per process, so this costs one failed insert per cold
// start at most, and zero once the migration is applied.

import type { SupabaseClient } from '@supabase/supabase-js'

export interface QueryLogRow {
  query: string
  had_results: boolean
  source_count: number
  top_similarity: number | null
  model: string | null
  latency_ms: number
  answer: string
  sources: { url: string; title: string }[]
  cache_hit: boolean
  input_tokens?: number | null
  output_tokens?: number | null
}

/** Columns that only exist once 007_query_detail.sql has been applied. */
const DETAIL_COLUMNS = ['answer', 'sources', 'cache_hit'] as const

// null = not yet known. Set on the first insert of the process.
let detailColumnsExist: boolean | null = null

/** PostgREST reports an unknown column in the payload as PGRST204. */
function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  if (error.code === 'PGRST204') return true
  const message = error.message ?? ''
  return /column .* does not exist|could not find the .* column/i.test(message)
}

function legacyShape(row: QueryLogRow) {
  const rest: Record<string, unknown> = { ...row }
  for (const column of DETAIL_COLUMNS) delete rest[column]
  // Without a cache_hit column, `model` is the only place left to say a row was
  // served from cache — which is exactly what it used to mean. Post-migration
  // `model` names the model that wrote the answer and cache_hit carries this;
  // pre-migration it goes back to standing in for both.
  if (row.cache_hit) rest.model = 'cache'
  return rest
}

/**
 * Fire-and-forget insert into query_log. Never throws and never rejects — a
 * failed log must not take an answer down with it, and every call site is on
 * the response path.
 */
export function logQuery(supabase: SupabaseClient, row: QueryLogRow): void {
  // answer_preview predates `answer` and is what the analytics endpoint reads.
  // Both are written so neither reader has to know about the other.
  const full = { ...row, answer_preview: row.answer.slice(0, 2000) }

  const write = async () => {
    if (detailColumnsExist === false) {
      await supabase.from('query_log').insert(legacyShape(full))
      return
    }

    const { error } = await supabase.from('query_log').insert(full)
    if (!error) {
      detailColumnsExist = true
      return
    }

    if (isMissingColumn(error)) {
      // Reached at most once per process — the early return above takes over as
      // soon as the flag is set. This is a "go run the migration" notice, not a
      // per-request error.
      console.warn(
        'query_log is missing the detail columns — apply supabase/migrations/007_query_detail.sql. ' +
          'Logging the legacy columns until then.'
      )
      detailColumnsExist = false
      await supabase.from('query_log').insert(legacyShape(full))
      return
    }

    console.error('query_log insert failed:', error.message)
  }

  void write().catch(e => console.error('query_log insert threw:', e))
}
