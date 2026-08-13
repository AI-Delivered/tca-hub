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
import { UNANSWERED_ILIKE, saidItCouldNotAnswer, unansweredOrFilter } from '@/lib/unanswered'
import { costOfRow } from '@/lib/pricing'

export const maxDuration = 30

// Rates live in src/lib/pricing.ts, shared with the stats route. This file used
// to hold its own copy "kept in sync by hand", which is how nano ended up priced
// as Haiku here while the totals elsewhere disagreed.

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
// Cache token columns (migration 008) are here because cost is priced from all
// three token counts, not just input_tokens — without them a cached row reported
// a smaller number here than the same row did on the stats page.
const FULL_COLUMNS =
  'id, query, created_at, had_results, source_count, top_similarity, model, latency_ms, answer, answer_preview, sources, cache_hit, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens'
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

const costOf = (row: Row): number | null => costOfRow(row)

// See lib/unanswered.ts for what "thin" means and why it stopped meaning
// "low similarity".
const unansweredOr = unansweredOrFilter()

/** Order matters — a failed generation is a failure first and a thin match second. */
function statusOf(row: Row): QueryStatus {
  // Rows written before migration 004 recorded the question and nothing else.
  // They are not "answered" — nobody recorded whether they were. Saying so is
  // the difference between an honest 494 and a made-up success rate.
  if (row.had_results == null) return 'unknown'
  if (row.model?.endsWith('-failed')) return 'failed'
  if (row.had_results === false) return 'empty'
  if (saidItCouldNotAnswer(row.answer_preview)) return 'thin'
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
        steps.push(
          ['eq', 'had_results', true],
          ['not', 'model', 'like', '%-failed'],
          ['or', unansweredOr]
        )
        break
      case 'answered':
        // The negation has to be one NOT ILIKE per pattern rather than a NOT
        // wrapped around the OR: 'answered' is "matched none of them", and each
        // step is ANDed, which is exactly that.
        steps.push(
          ['eq', 'had_results', true],
          ['not', 'model', 'like', '%-failed'],
          ...UNANSWERED_ILIKE.map(p => ['not', 'answer_preview', 'ilike', p] as FilterStep)
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

  /* "Costliest" cannot be an ORDER BY, because cost is not a column.
   *
   * It used to sort by output_tokens, on the reasonable-sounding grounds that
   * output is billed at 5x input. Measured over the whole log, input is 96% of
   * what this app actually spends — answers are short and the retrieved context
   * is not. So the sort was ranking by about 4% of the bill: the single most
   * expensive query on record, 126,750 input tokens for $0.127, sat at #236 in
   * the costliest view, and only 3 of the true top 10 appeared in it at all.
   *
   * Sorting by input_tokens instead is no better — 2 of 10 — because the
   * priciest rows are Sonnet, where a token costs 3x what it does on Haiku.
   * Neither column ranks cost; only input, output and model together do.
   *
   * So this reads the tokens for the filtered window, ranks in JS, and then
   * fetches only the page's rows. The scan is capped and says when it truncated
   * rather than quietly ranking a subset.
   */
  const COST_SCAN_CAP = 20_000

  const costRankedIds = async (withDetail: boolean): Promise<{ ids: number[]; total: number; truncated: boolean }> => {
    const scanned: Pick<Row, 'id' | 'model' | 'input_tokens' | 'output_tokens'>[] = []
    let truncated = false
    for (let from = 0; from < COST_SCAN_CAP; from += 1000) {
      const { data } = await applySteps(
        supabase.from('query_log').select('id, model, input_tokens, output_tokens').gte('created_at', since),
        filterSteps(status, withDetail)
      ).order('id', { ascending: false }).range(from, from + 999)
      const page = (data ?? []) as unknown as typeof scanned
      scanned.push(...page)
      if (page.length < 1000) break
      if (from + 1000 >= COST_SCAN_CAP) truncated = true
    }
    scanned.sort((a, b) => (costOf(b as Row) ?? 0) - (costOf(a as Row) ?? 0) || b.id - a.id)
    return { ids: scanned.slice(offset, offset + limit).map(r => r.id), total: scanned.length, truncated }
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

  const runByCost = async (withDetail: boolean) => {
    const { ids, total, truncated } = await costRankedIds(withDetail)
    if (!ids.length) return { data: [], error: null, count: total, costTruncated: truncated }
    const { data, error } = await supabase
      .from('query_log')
      .select(withDetail ? FULL_COLUMNS : LEGACY_COLUMNS)
      .in('id', ids)
    // `.in` returns rows in whatever order Postgres likes; the ranking is ours.
    const order = new Map(ids.map((id, i) => [id, i]))
    const sorted = ((data ?? []) as unknown as Row[]).slice()
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    return { data: sorted as unknown as typeof data, error, count: total, costTruncated: truncated }
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
  let costTruncated = false
  const execute = async (detail: boolean) => {
    if (sortKey !== 'costliest') return { ...(await run(detail)), costTruncated: false }
    return await runByCost(detail)
  }
  let { data, error, count } = await execute(withDetail).then(r => {
    costTruncated = r.costTruncated
    return r
  })

  if (error && withDetail && isMissingColumn(error)) {
    console.warn(
      'query_log is missing the detail columns — apply supabase/migrations/007_query_detail.sql ' +
        'to see full answers and sources in the dashboard.'
    )
    detailColumnsExist = false
    withDetail = false
    ;({ data, error, count, costTruncated } = await execute(false))
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
    // True only when the cost ranking had to stop short of the whole window.
    // A ranking built from a subset should say so rather than look complete.
    costRankTruncated: costTruncated,
  })
}
