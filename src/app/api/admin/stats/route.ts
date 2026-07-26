import { getSupabaseAdmin } from '@/lib/supabase'
import { queryKey } from '@/lib/query-key'
import { secretMatches } from '@/lib/auth'

export const maxDuration = 30

// Pricing per million tokens (input/output) — kept in sync with shared/models.md pricing tables
const PRICING = {
  haiku: { input: 1.0, output: 5.0 },
  sonnet: { input: 3.0, output: 15.0 },
}

// Maps a failing query to the content category it's most likely asking about,
// and the crawl route that would actually fix it — so a gap in the dashboard
// points directly at "run this ingest job" instead of just "something's missing."
const CATEGORIES: { key: string; label: string; ingestRoute: string; pattern: RegExp }[] = [
  {
    key: 'staff',
    label: 'Staff directory',
    ingestRoute: '/api/crawl/ingest-staff',
    pattern: /\bwho\s+is\b|\bmr\.?\s|\bmrs\.?\s|\bms\.?\s|\bcoach\b|\bteacher\b|\be-?mail\b|\bcontact\b|\bprincipal\b|\bstaff\b/i,
  },
  {
    key: 'athletics',
    label: 'Athletics schedules',
    ingestRoute: '/api/crawl/ingest-ical',
    pattern: /\bpractice\b|\bgame\b|\bscrimmage\b|\btournament\b|\bmatch\b|\bmeet\b|\bplayoff\b|\btryout\b|\bfootball\b|\bbasketball\b|\bsoccer\b|\bvolleyball\b|\bbaseball\b|\bsoftball\b|\btrack\b|\bswim\b|\bwrestling\b|\bcheer\b|\bdance\b|\bgolf\b|\btennis\b|\bcross country\b|\blacrosse\b/i,
  },
  {
    key: 'calendar',
    label: 'School calendar / no-school days',
    ingestRoute: '/api/crawl/ingest-calendar',
    pattern: /\bschool start\b|\bbreak\b|\bholiday\b|\bno school\b|\bday(s)? off\b|\bcalendar\b|\bworkday\b|\binservice\b|\bearly (release|out)\b|\bfirst day\b|\blast day\b/i,
  },
  {
    key: 'forms',
    label: 'Forms / PDFs',
    ingestRoute: '/api/crawl/ingest-pdfs',
    pattern: /\bform\b|\bpermit\b|\bregistration\b|\bapplication\b|\bhandbook\b/i,
  },
  {
    key: 'general',
    label: 'General site content',
    ingestRoute: '/api/crawl/ingest-deep',
    pattern: /.*/,
  },
]

function categorize(query: string) {
  const c = CATEGORIES.find(c => c.pattern.test(query))
  return c ?? CATEGORIES[CATEGORIES.length - 1]
}

interface LogRow {
  id: number
  query: string
  created_at: string
  had_results: boolean | null
  source_count: number | null
  top_similarity: number | null
  model: string | null
  latency_ms: number | null
  answer_preview: string | null
  input_tokens: number | null
  output_tokens: number | null
}

// The dashboard is a speed bump, not a vault — but the check belongs here rather
// than in the page, so the numbers aren't served to anyone who simply skips the UI.
//
// Two changes from the first version. The password no longer falls back to a
// literal in this file: an unset ADMIN_PASSWORD now closes the door instead of
// leaving "asdf" as the production password. And it is read from the header
// only — accepting `?key=` meant the password rode along in Vercel's request
// logs, in the browser's history, and in the Referer sent to any link clicked
// from the page.
function isAuthorized(req: Request): boolean {
  return secretMatches(req.headers.get('x-admin-key'), process.env.ADMIN_PASSWORD)
}

export async function GET(req: Request) {
  if (!process.env.ADMIN_PASSWORD) {
    // Said out loud rather than as a bare 401, because the difference between
    // "wrong password" and "nobody set one" is the difference between a typo
    // and a five-second fix in the Vercel dashboard.
    return Response.json({ error: 'Dashboard password is not configured — set ADMIN_PASSWORD.' }, { status: 503 })
  }
  if (!isAuthorized(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { searchParams } = new URL(req.url)
  const days = Math.min(Math.max(Number(searchParams.get('days') ?? 30), 1), 90)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  const supabase = getSupabaseAdmin()
  const [{ data, error }, { data: visitData, error: visitError }] = await Promise.all([
    supabase
      .from('query_log')
      .select('id, query, created_at, had_results, source_count, top_similarity, model, latency_ms, answer_preview, input_tokens, output_tokens')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(5000),
    supabase
      .from('page_visits')
      .select('created_at, visitor_id')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(5000),
  ])

  if (error || visitError) {
    console.error('admin stats query failed:', error?.message ?? visitError?.message)
    return Response.json({ error: 'Could not load analytics.' }, { status: 500 })
  }

  const rows = (data ?? []) as LogRow[]
  const visits = (visitData ?? []) as { created_at: string; visitor_id: string | null }[]

  const total = rows.length
  const allNoResults = rows.filter(r => r.had_results === false)
  const withResults = rows.filter(r => r.had_results === true)
  const allThinResults = withResults.filter(r => (r.top_similarity ?? 1) < 0.6)

  // The needs-attention lists describe the CURRENT state of each question, not
  // its history: a question is judged by its most recent run, so one that's since
  // been fixed drops off, and one that broke again after a fix comes back.
  // Questions are compared on their canonical form, so "Who's the middle school
  // principal", "Whos the MS principal" and "who is the junior high principal"
  // are one question — see src/lib/query-key.ts.
  const normalize = queryKey
  const latestRun = new Map<string, LogRow>()
  for (const r of rows) {
    const key = normalize(r.query)
    if (!key) continue
    const prev = latestRun.get(key)
    if (!prev || Date.parse(r.created_at) > Date.parse(prev.created_at)) latestRun.set(key, r)
  }
  const stillFailing = (r: LogRow) => {
    const latest = latestRun.get(normalize(r.query))
    if (!latest) return true
    return latest.had_results === false || (latest.top_similarity ?? 1) < 0.6
  }

  const noResults = allNoResults.filter(stillFailing)
  const thinResults = allThinResults.filter(stillFailing)
  const resolvedCount = new Set(
    [...allNoResults, ...allThinResults].filter(r => !stillFailing(r)).map(r => normalize(r.query))
  ).size

  const latencies = rows.map(r => r.latency_ms).filter((v): v is number => v != null).sort((a, b) => a - b)
  const avgLatency = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null
  const p95Latency = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : null

  // Daily volume, bucketed by UTC date
  const byDay = new Map<string, { total: number; noResults: number }>()
  for (const r of rows) {
    const day = r.created_at.slice(0, 10)
    const bucket = byDay.get(day) ?? { total: 0, noResults: 0 }
    bucket.total++
    if (r.had_results === false) bucket.noResults++
    byDay.set(day, bucket)
  }
  const dailyVolume = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, ...v }))

  // Site visits — every page load, separate from query_log (which only fires
  // when someone actually asks a question). Shows total traffic vs. how much
  // of it converts into a chatbot query.
  const uniqueVisitorIds = new Set(visits.map(v => v.visitor_id).filter((v): v is string => !!v))
  const visitsByDay = new Map<string, number>()
  for (const v of visits) {
    const day = v.created_at.slice(0, 10)
    visitsByDay.set(day, (visitsByDay.get(day) ?? 0) + 1)
  }
  const dailyVisits = [...visitsByDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }))
  const visitStats = {
    total: visits.length,
    uniqueVisitors: uniqueVisitorIds.size,
    dailyVisits,
    queryRate: visits.length ? total / visits.length : null,
  }

  // Top repeated queries (case-insensitive, trimmed)
  const freq = new Map<string, { query: string; count: number; noResultCount: number }>()
  for (const r of rows) {
    const key = normalize(r.query)
    if (!key) continue
    const bucket = freq.get(key) ?? { query: r.query.trim(), count: 0, noResultCount: 0 }
    bucket.count++
    if (r.had_results === false) bucket.noResultCount++
    freq.set(key, bucket)
  }
  const topQueries = [...freq.values()].sort((a, b) => b.count - a.count).slice(0, 20)

  // Questions that hit "no context" at least once — the direct answer to
  // "which questions are we failing on," with how often each was asked vs. failed.
  const stillBroken = (query: string) => {
    const latest = latestRun.get(normalize(query))
    return !latest || latest.had_results === false || (latest.top_similarity ?? 1) < 0.6
  }

  const noContextHitQueries = [...freq.values()]
    .filter(q => q.noResultCount > 0 && stillBroken(q.query))
    .sort((a, b) => b.noResultCount - a.noResultCount || b.count - a.count)

  // No-context queries, most recent first, deduped by text
  const noResultSeen = new Set<string>()
  const noResultQueries = noResults
    .filter(r => {
      const key = normalize(r.query)
      if (noResultSeen.has(key)) return false
      noResultSeen.add(key)
      return true
    })
    .slice(0, 50)
    .map(r => ({ query: r.query, created_at: r.created_at }))

  // Thin-context queries — we found sources but the best match was weak
  const thinQueries = thinResults
    .slice(0, 30)
    .map(r => ({ query: r.query, similarity: r.top_similarity, created_at: r.created_at, answer: r.answer_preview }))

  // Content gaps — every failing query (no-context or thin-context), grouped by
  // category so a spike points at a specific ingest route to re-run, not just
  // "something's missing." Weighted by total occurrences (not deduped) so a
  // question asked 8 times outweighs one asked once.
  const gapRows = [...noResults, ...thinResults]
  const gapsByCategory = new Map<string, { key: string; label: string; ingestRoute: string; count: number; samples: Set<string> }>()
  for (const r of gapRows) {
    const cat = categorize(r.query)
    const bucket = gapsByCategory.get(cat.key) ?? { key: cat.key, label: cat.label, ingestRoute: cat.ingestRoute, count: 0, samples: new Set<string>() }
    bucket.count++
    if (bucket.samples.size < 6) bucket.samples.add(r.query.trim())
    gapsByCategory.set(cat.key, bucket)
  }
  const contentGaps = [...gapsByCategory.values()]
    .sort((a, b) => b.count - a.count)
    .map(g => ({ key: g.key, label: g.label, ingestRoute: g.ingestRoute, count: g.count, samples: [...g.samples] }))

  // Actual API cost — priced per-row using whichever model actually served that
  // query (queries route between Haiku and Sonnet, see search/route.ts), not a
  // blanket single-model estimate.
  const totalInputTokens = rows.reduce((sum, r) => sum + (r.input_tokens ?? 0), 0)
  const totalOutputTokens = rows.reduce((sum, r) => sum + (r.output_tokens ?? 0), 0)
  let totalCost = 0
  let sonnetQueries = 0
  let pricedQueries = 0
  for (const r of rows) {
    if (r.input_tokens == null && r.output_tokens == null) continue // pre-instrumentation row — no token data to price
    pricedQueries++
    const pricing = r.model?.includes('sonnet') ? PRICING.sonnet : PRICING.haiku
    if (r.model?.includes('sonnet')) sonnetQueries++
    totalCost += ((r.input_tokens ?? 0) / 1_000_000) * pricing.input
    totalCost += ((r.output_tokens ?? 0) / 1_000_000) * pricing.output
  }
  const cost = {
    totalInputTokens,
    totalOutputTokens,
    totalCost,
    sonnetQueries,
    pricedQueries,
  }

  return Response.json({
    days,
    total,
    // Headline counts stay historical — they describe the window, not the to-do
    // list. The lists below are the to-do list, and drop anything since fixed.
    noResultCount: allNoResults.length,
    noResultRate: total ? allNoResults.length / total : 0,
    thinResultCount: allThinResults.length,
    resolvedCount,
    avgLatency,
    p95Latency,
    dailyVolume,
    topQueries,
    noContextHitQueries,
    noResultQueries,
    thinQueries,
    contentGaps,
    cost,
    visits: visitStats,
  })
}
