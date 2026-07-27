// Reading individual queries back, as opposed to counting them.
//
// /api/admin/stats answers "how is retrieval doing" — rates, totals, which
// categories are failing. It deliberately returns aggregates and three short
// curated lists, and it caps its scan at 5000 rows, because that is all an
// overview needs.
//
// This endpoint answers the other question: "what exactly did we tell the
// person who asked X, when, from what, and what did it cost?" That means whole
// rows, the full answer text, the source URLs, and enough filtering and paging
// to walk a 90-day log without loading it into a browser tab. Filtering, sorting
// and paging all happen in Postgres for that reason — none of this is a slice
// of an array that was fetched in full first.

import { getSupabaseAdmin } from '@/lib/supabase'
import { secretMatches } from '@/lib/auth'

export const maxDuration = 30

// Same table as src/app/api/admin/stats/route.ts. Kept in sync by hand; if they
// ever disagree, stats is the one that has been checked against a real bill.
const PRICING: Record<'haiku' | 'sonnet', { input: number; output: number }> = {
  haiku: { input: 1.0, output: 5.0 },
  sonnet: { input: 3.0, output: 15.0 },
}

/** Matches the dashboard's definition of a weak retrieval hit. */
const THIN_THRESHOLD = 0.6

const PAGE_SIZE_DEFAULT = 25
const PAGE_SIZE_MAX = 100

// How the *retrieval* went. Deliberately does not include "cached": whether an
// answer was served from cache is orthogonal to whether it was any good — a
// cached answer built on a weak match is still a weak answer — and folding the
// two into one field meant the "answered" count and the "answered" list
// disagreed about the same rows. Cache is reported alongside as `cached`.
export type QueryStatus = 'answered' | 'thin' | 'empty' | 'failed' | 'unknown'

const SORTS = {
  recent: { column: 'created_at', ascending: false },
  oldest: { column: 'created_at', ascending: true },
  slowest: { column: 'latency_ms', ascending: false },
  weakest: { column: 'top_similarity', ascending: true },
  costliest: { column: 'output_tokens', ascending: false },
} as const

type SortKey = keyof typeof SORTS

interface Row {
  id: number
  query: string
  created_at: string
  had_results: boolean | null
  source_count: number | null
  top_similarity: number | null
  model: string | null
  latency_ms: number | null
  answer: string | null
  answer_preview: string | null
  sources: unknown
  cache_hit: boolean | null
  input_tokens: number | null
  output_tokens: number | null
}

// Every column the explorer shows. `answer` / `sources` / `cache_hit` arrive
// with migration 007; before it is applied Postgres rejects the whole select
// rather than returning the columns it does have, so the fallback below drops
// them and the UI degrades to what the legacy columns can say.
const FULL_COLUMNS =
  'id, query, created_at, had_results, source_count, top_similarity, model, latency_ms, answer, answer_preview, sources, cache_hit, input_tokens, output_tokens'
const LEGACY_COLUMNS =
  'id, query, created_at, had_results, source_count, top_similarity, model, latency_ms, answer_preview, input_tokens, output_tokens'

let detailColumnsExist: boolean | null = null

function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  // 42703 is Postgres "undefined column"; PGRST204 is PostgREST's schema-cache
  // equivalent. Either can surface depending on where the request is rejected.
  if (error.code === '42703' || error.code === 'PGRST204') return true
  return /column .* does not exist|could not find the .* column/i.test(error.message ?? '')
}

function costOf(row: Row): number | null {
  if (row.input_tokens == null && row.output_tokens == null) return null
  const pricing = row.model?.includes('sonnet') ? PRICING.sonnet : PRICING.haiku
  return (
    ((row.input_tokens ?? 0) / 1_000_000) * pricing.input +
    ((row.output_tokens ?? 0) / 1_000_000) * pricing.output
  )
}

/** Order matters — a failed generation is a failure first and a thin match second. */
function statusOf(row: Row): QueryStatus {
  // Rows written before migration 004 recorded the question and nothing else.
  // They are not "answered" — nobody recorded whether they were. Saying so is
  // the difference between an honest 494 and a made-up success rate.
  if (row.had_results == null) return 'unknown'
  if (row.model?.endsWith('-failed')) return 'failed'
  if (row.had_results === false) return 'empty'
  if (row.top_similarity != null && row.top_similarity < THIN_THRESHOLD) return 'thin'
  return 'answered'
}

function wasCached(row: Row): boolean {
  // `model = 'cache'` is how rows written before migration 007 said this.
  return row.cache_hit === true || row.model === 'cache'
}

function parseSources(value: unknown): { url: string; title: string }[] | null {
  if (!value) return null
  // jsonb comes back parsed, but a hand-run backfill could leave a string.
  const raw = typeof value === 'string' ? safeParse(value) : value
  if (!Array.isArray(raw)) return null
  return raw
    .filter((s): s is { url: string; title?: string } => !!s && typeof s === 'object' && typeof (s as { url?: unknown }).url === 'string')
    .map(s => ({ url: s.url, title: typeof s.title === 'string' ? s.title : s.url }))
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

// PostgREST's filter grammar is comma- and paren-delimited, so those characters
// in a search term would be read as syntax rather than as text. `%` and `_` are
// LIKE wildcards and `\` escapes them. None of them are plausible in a search
// for a parent's question, so they are dropped rather than escaped.
function sanitizeSearch(term: string): string {
  return term.replace(/[,()%_\\*"']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
}

function isAuthorized(req: Request): boolean {
  return secretMatches(req.headers.get('x-admin-key'), process.env.ADMIN_PASSWORD)
}

/** Every chip the explorer offers. 'all' is the unfiltered count. */
const FACETS = ['all', 'answered', 'thin', 'empty', 'failed', 'cached', 'unknown'] as const

/** One supabase-js filter call, as data. See filterSteps() for why. */
type FilterStep =
  | ['eq', string, unknown]
  | ['is', string, unknown]
  | ['lt', string, number]
  | ['like', string, string]
  | ['not', string, string, unknown]
  | ['or', string]

/**
 * Replays filter steps onto a supabase-js builder. The `any` is contained here
 * and is the point of the exercise: every builder shape has these methods, but
 * their static types are parameterised by the select() string, so nothing
 * weaker than `any` lets one function filter both a row query and a head-only
 * count query.
 */
function applySteps<T>(builder: T, steps: FilterStep[]): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  let q = builder as any
  for (const [method, ...args] of steps) q = q[method](...args)
  return q as T
}

export async function GET(req: Request) {
  if (!process.env.ADMIN_PASSWORD) {
    return Response.json({ error: 'Dashboard password is not configured — set ADMIN_PASSWORD.' }, { status: 503 })
  }
  if (!isAuthorized(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const days = Math.min(Math.max(Number(searchParams.get('days') ?? 30) || 30, 1), 90)
  const limit = Math.min(Math.max(Number(searchParams.get('limit') ?? PAGE_SIZE_DEFAULT) || PAGE_SIZE_DEFAULT, 1), PAGE_SIZE_MAX)
  const offset = Math.max(Number(searchParams.get('offset') ?? 0) || 0, 0)
  const requestedSort = searchParams.get('sort') ?? ''
  const sortKey: SortKey = Object.hasOwn(SORTS, requestedSort) ? (requestedSort as SortKey) : 'recent'
  const status = searchParams.get('status') ?? 'all'
  const search = sanitizeSearch(searchParams.get('q') ?? '')

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const supabase = getSupabaseAdmin()

  // The filter is described as data rather than applied to a builder directly,
  // for one reason: the row fetch and the facet counts must be the same filter.
  // A chip reading "Thin 104" and the list it opens are built from this one
  // function, so they cannot drift. (Passing a half-built supabase-js builder
  // between functions is the obvious alternative and doesn't survive its
  // generics — the select() string is part of the builder's type.)
  const filterSteps = (status: string, withDetail: boolean): FilterStep[] => {
    const steps: FilterStep[] = []

    // `cache_hit` only exists post-migration, so this falls back to the
    // `model = 'cache'` convention the column replaced.
    const cachedFilter = withDetail ? 'cache_hit.is.true,model.eq.cache' : 'model.eq.cache'
    switch (status) {
      case 'empty':
        steps.push(['eq', 'had_results', false])
        break
      case 'failed':
        steps.push(['like', 'model', '%-failed'])
        break
      case 'cached':
        steps.push(['or', cachedFilter])
        break
      case 'unknown':
        steps.push(['is', 'had_results', null])
        break
      // `had_results = true` is also what keeps `model` non-null on these two
      // branches — every row that found context recorded which model answered.
      // That matters because `NOT (model LIKE '%-failed')` is NULL, not true,
      // for a null model, so a null-model row would silently vanish from both
      // lists while its badge still claimed a status.
      case 'thin':
        // `.lt` already excludes nulls, so a row with no similarity recorded
        // can't land here — only genuinely weak retrieval does.
        steps.push(
          ['eq', 'had_results', true],
          ['lt', 'top_similarity', THIN_THRESHOLD],
          ['not', 'model', 'like', '%-failed']
        )
        break
      case 'answered':
        steps.push(
          ['eq', 'had_results', true],
          ['not', 'model', 'like', '%-failed'],
          ['or', `top_similarity.gte.${THIN_THRESHOLD},top_similarity.is.null`]
        )
        break
      default:
        break
    }

    if (search) {
      // Searches the question and, once the column exists, the answer — "what
      // did we ever say about carpool?" is as common a question as "who asked
      // about carpool?".
      steps.push([
        'or',
        withDetail
          ? `query.ilike.%${search}%,answer.ilike.%${search}%,answer_preview.ilike.%${search}%`
          : `query.ilike.%${search}%,answer_preview.ilike.%${search}%`,
      ])
    }

    return steps
  }

  const run = (withDetail: boolean) => {
    const base = supabase
      .from('query_log')
      .select(withDetail ? FULL_COLUMNS : LEGACY_COLUMNS, { count: 'exact' })
      .gte('created_at', since)

    const sort = SORTS[sortKey]
    return applySteps(base, filterSteps(status, withDetail))
      .order(sort.column, { ascending: sort.ascending, nullsFirst: false })
      // A stable tiebreaker: without it, rows sharing a latency or similarity
      // can reshuffle between pages and the same row shows up twice.
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1)
  }

  // How many rows sit behind each chip, under the current search and range.
  // head:true means Postgres returns the count without materialising a single
  // row, so this is seven cheap counts rather than seven result sets.
  const runFacets = async (withDetail: boolean) => {
    const counts = await Promise.all(
      FACETS.map(name =>
        applySteps(
          supabase.from('query_log').select('id', { count: 'exact', head: true }).gte('created_at', since),
          filterSteps(name, withDetail)
        ).then(r => r.count ?? 0)
      )
    )
    return Object.fromEntries(FACETS.map((name, i) => [name, counts[i]])) as Record<(typeof FACETS)[number], number>
  }

  let withDetail = detailColumnsExist !== false
  let { data, error, count } = await run(withDetail)

  if (error && withDetail && isMissingColumn(error)) {
    console.warn(
      'query_log is missing the detail columns — apply supabase/migrations/007_query_detail.sql ' +
        'to see full answers and sources in the dashboard.'
    )
    detailColumnsExist = false
    withDetail = false
    ;({ data, error, count } = await run(false))
  } else if (!error && withDetail) {
    detailColumnsExist = true
  }

  if (error) {
    console.error('admin queries lookup failed:', error.message)
    return Response.json({ error: 'Could not load the query log.' }, { status: 500 })
  }

  const rows = ((data ?? []) as unknown as Row[]).map(r => ({
    id: r.id,
    query: r.query,
    created_at: r.created_at,
    // Post-migration `answer` is the untruncated text; `answer_preview` is the
    // 2000-character copy every row has had since 004.
    answer: r.answer ?? r.answer_preview ?? '',
    answerTruncated: r.answer == null && (r.answer_preview?.length ?? 0) >= 2000,
    sources: parseSources(r.sources),
    sourceCount: r.source_count,
    similarity: r.top_similarity,
    model: r.model,
    latencyMs: r.latency_ms,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cost: costOf(r),
    status: statusOf(r),
    cached: wasCached(r),
  }))

  const total = count ?? rows.length

  // Only on the first page. "Load more" keeps whatever the chips already show —
  // paging deeper into a filter cannot change how many rows match it, so
  // re-counting on every page would be six queries spent to redraw the same
  // numbers.
  const facets = offset === 0 ? await runFacets(withDetail) : null

  return Response.json({
    rows,
    total,
    facets,
    offset,
    limit,
    hasMore: offset + rows.length < total,
    days,
    sort: sortKey,
    status,
    q: search,
    // Lets the UI say "run the migration to see sources" rather than silently
    // showing every row as having none.
    detail: withDetail,
  })
}
