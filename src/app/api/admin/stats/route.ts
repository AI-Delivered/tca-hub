import { getSupabaseAdmin } from '@/lib/supabase'
import { queryKey } from '@/lib/query-key'
import { secretMatches } from '@/lib/auth'

export const maxDuration = 30

// Pricing per million tokens (input/output) — kept in sync with shared/models.md pricing tables
const PRICING = {
  haiku: { input: 1.0, output: 5.0 },
  sonnet: { input: 3.0, output: 15.0 },
}

interface PricedRow {
  model?: string | null
  input_tokens?: number | null
  output_tokens?: number | null
}

/** Prices a set of logged queries. Rows predating token logging are skipped
 *  rather than counted as free, and reported separately so a partial total
 *  can be labelled as one. */
function priceRows(rows: PricedRow[]) {
  let cost = 0
  let sonnetQueries = 0
  let pricedQueries = 0
  for (const r of rows) {
    if (r.input_tokens == null && r.output_tokens == null) continue
    pricedQueries++
    const isSonnet = Boolean(r.model?.includes('sonnet'))
    if (isSonnet) sonnetQueries++
    const pricing = isSonnet ? PRICING.sonnet : PRICING.haiku
    cost += ((r.input_tokens ?? 0) / 1_000_000) * pricing.input
    cost += ((r.output_tokens ?? 0) / 1_000_000) * pricing.output
  }
  return { cost, sonnetQueries, pricedQueries }
}

// Credit burn-down. Anthropic exposes no balance endpoint — remaining credit is
// a Console-only number — so the budget is a figure you supply and this counts
// down against it. ANTHROPIC_CREDIT_SINCE resets the baseline after a top-up;
// without it the count runs over all logged history.
const CREDIT_BUDGET = Number(process.env.ANTHROPIC_CREDIT_BUDGET) || null
const CREDIT_SINCE = process.env.ANTHROPIC_CREDIT_SINCE || null
// Enough rows for roughly a year at current volume. If it ever truncates, the
// response says so — an understated burn-down that looks precise is the one
// genuinely dangerous way for this to fail.
const BUDGET_ROW_LIMIT = 20000

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

/* Where the knowledge base comes from, and whether it is still arriving.
 *
 * Every failure this app has had in practice has been a silent one: an ingest
 * route that returned 0 and said nothing, feeds that were removed from the
 * config while their chunks stayed in the database for weeks, a school calendar
 * that stopped publishing after May. None of it was visible anywhere — the
 * dashboard could tell you a question got a thin answer but never that the
 * content behind it was four days stale or last year's.
 *
 * `maxAgeHours` is what "fresh" means for each source, derived from its cron in
 * vercel.json plus room for one missed run. */
const SOURCES: { key: string; label: string; pattern: string; maxAgeHours: number; note: string }[] = [
  { key: 'athletics', label: 'Athletics schedule (GoBound)', pattern: '%gobound%', maxAgeHours: 12, note: 'ingest-calendar every 4h, ingest-bound daily' },
  { key: 'teamreach', label: 'Team feeds (TeamReach)', pattern: '%teamreach%', maxAgeHours: 12, note: 'ingest-ical every 6h — the only source of practice times' },
  { key: 'calendars', label: 'School calendars', pattern: '%-calendar%', maxAgeHours: 12, note: 'ingest-ical every 6h' },
  { key: 'staff', label: 'Staff directories', pattern: '%staff-directory%', maxAgeHours: 24 * 8, note: 'ingest-staff weekly' },
  { key: 'documents', label: 'Documents & PDFs', pattern: '%resource-manager%', maxAgeHours: 24 * 8, note: 'ingest-pdfs weekly' },
  { key: 'documents_cdn', label: 'Documents (Finalsite CDN)', pattern: '%finalsite.net%', maxAgeHours: 24 * 8, note: 'ingest-pdfs weekly' },
]

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
  // Spend against the budget is deliberately NOT scoped to the selected range —
  // credit is consumed once, so a burn-down that shrank when you clicked "7d"
  // would be nonsense. This reads from the top-up baseline forward regardless
  // of which range the page is showing.
  const budgetQuery = CREDIT_BUDGET
    ? supabase
        .from('query_log')
        .select('model, input_tokens, output_tokens, created_at')
        .gte('created_at', CREDIT_SINCE ?? '1970-01-01')
        .order('created_at', { ascending: false })
        .limit(BUDGET_ROW_LIMIT)
    : null

  const [{ data, error }, { data: visitData, error: visitError }, budgetRes] = await Promise.all([
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
    budgetQuery,
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
  const windowCost = priceRows(rows)
  const cost = {
    totalInputTokens,
    totalOutputTokens,
    totalCost: windowCost.cost,
    sonnetQueries: windowCost.sonnetQueries,
    pricedQueries: windowCost.pricedQueries,
  }

  // ── Credit burn-down ──
  // A projection, not a balance: it answers "when do I run out at this rate",
  // which is the question a balance is usually a proxy for anyway.
  let budget = null
  if (CREDIT_BUDGET) {
    const budgetRows = (budgetRes?.data ?? []) as (PricedRow & { created_at: string })[]
    const spent = priceRows(budgetRows).cost

    // Rate comes from the trailing 7 days, not from the whole baseline period —
    // averaging over months of history would badly lag a recent change in
    // traffic, which is exactly when the projection matters.
    const rateWindowStart = Date.now() - 7 * 24 * 60 * 60 * 1000
    const recent = budgetRows.filter(r => new Date(r.created_at).getTime() >= rateWindowStart)
    const recentSpend = priceRows(recent).cost
    // Days of history actually available, so a two-day-old log doesn't get
    // divided by seven and report a burn rate 3.5x too low.
    const oldestRecent = recent.length
      ? Math.min(...recent.map(r => new Date(r.created_at).getTime()))
      : Date.now()
    const observedDays = Math.max(0.5, Math.min(7, (Date.now() - oldestRecent) / 86_400_000))
    const perDay = recent.length ? recentSpend / observedDays : 0

    const remaining = CREDIT_BUDGET - spent
    budget = {
      amount: CREDIT_BUDGET,
      since: CREDIT_SINCE,
      spent,
      remaining,
      perDay,
      daysLeft: perDay > 0 && remaining > 0 ? remaining / perDay : null,
      // Signals the total is a floor rather than an exact figure.
      truncated: budgetRows.length >= BUDGET_ROW_LIMIT,
    }
  }

  // Freshness per source. Two cheap reads each: an exact count, and the single
  // most recent row, which is what says whether the cron is still landing.
  const sources = await Promise.all(
    SOURCES.map(async src => {
      const [{ count }, { data: newest }] = await Promise.all([
        supabase.from('page_chunks').select('id', { count: 'exact', head: true }).ilike('url', src.pattern),
        supabase
          .from('page_chunks')
          .select('crawled_at')
          .ilike('url', src.pattern)
          .order('crawled_at', { ascending: false, nullsFirst: false })
          .limit(1),
      ])
      const lastCrawled = newest?.[0]?.crawled_at ?? null
      const ageHours = lastCrawled ? (Date.now() - Date.parse(lastCrawled)) / 3_600_000 : null
      return {
        key: src.key,
        label: src.label,
        note: src.note,
        chunks: count ?? 0,
        lastCrawled,
        ageHours,
        // Empty is its own state: "the scraper ran and found nothing" and "this
        // source is hours behind" need different fixes, and an off-season sport
        // is neither.
        status:
          (count ?? 0) === 0 ? 'empty'
          : ageHours == null ? 'unknown'
          : ageHours > src.maxAgeHours ? 'stale'
          : 'ok',
      }
    })
  )

  return Response.json({
    days,
    total,
    budget,
    sources,
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
