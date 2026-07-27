import { secretMatches } from '@/lib/auth'

export const maxDuration = 30

// Anthropic's Usage & Cost Admin API. Two separate endpoints:
//   usage_report/messages — token counts, groupable by model
//   cost_report           — billed dollars, daily buckets only
//
// This is deliberately a *different* number from the cost on the analytics
// dashboard. That one is derived: token counts we logged ourselves, multiplied
// by a hardcoded price table. This one is what Anthropic actually billed. When
// they disagree the derived one is wrong — a model we mispriced, a retry we
// didn't log, cache reads we never counted — which is the whole reason to show
// both instead of trusting ours.
const API = 'https://api.anthropic.com/v1/organizations'
const VERSION = '2023-06-01'

// The admin key is organization-scoped, so by default these numbers cover every
// project in the org, not just this app. ANTHROPIC_ADMIN_API_KEY_ID narrows them
// to the one key TCA Hub uses. Without it the panel says so rather than
// quietly reporting someone else's spend as this app's.
const SCOPED_KEY_ID = process.env.ANTHROPIC_ADMIN_API_KEY_ID

// Usage data lands within ~5 minutes and Anthropic asks for at most one poll a
// minute; a dashboard someone leaves open would blow past that on range
// switches alone. Cached per-window, process-local.
const TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { at: number; body: unknown }>()

interface CostBucket {
  starting_at: string
  results: { amount: string; currency: string; description?: string | null }[]
}
interface UsageBucket {
  starting_at: string
  results: {
    uncached_input_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    output_tokens?: number
    model?: string | null
  }[]
}

async function adminGet<T>(path: string, params: URLSearchParams, key: string): Promise<T> {
  const res = await fetch(`${API}/${path}?${params}`, {
    headers: {
      'x-api-key': key,
      'anthropic-version': VERSION,
      // Anthropic asks integrations to identify themselves so they can see
      // usage patterns; ours is a once-per-5-minutes dashboard poll.
      'User-Agent': 'tca-hub-dashboard/1.0 (https://tca-hub.vercel.app)',
    },
    // Never let a slow upstream hold the dashboard hostage — the panel
    // degrades to "unavailable" and the rest of the page still renders.
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Anthropic admin API ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
  }
  return res.json() as Promise<T>
}

/** Walks `next_page` until the API says there's no more. */
async function paginate<B>(path: string, base: URLSearchParams, key: string): Promise<B[]> {
  const buckets: B[] = []
  let page: string | undefined
  // A hard stop so a pagination bug upstream can't spin this route forever.
  for (let i = 0; i < 12; i++) {
    const params = new URLSearchParams(base)
    if (page) params.set('page', page)
    const body = await adminGet<{ data: B[]; has_more: boolean; next_page: string | null }>(path, params, key)
    buckets.push(...(body.data ?? []))
    if (!body.has_more || !body.next_page) break
    page = body.next_page
  }
  return buckets
}

export async function GET(req: Request) {
  if (!process.env.ADMIN_PASSWORD) {
    return Response.json({ error: 'Dashboard password is not configured — set ADMIN_PASSWORD.' }, { status: 503 })
  }
  if (!secretMatches(req.headers.get('x-admin-key'), process.env.ADMIN_PASSWORD)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const adminKey = process.env.ANTHROPIC_ADMIN_KEY
  if (!adminKey) {
    // Not an error state — most deployments won't have this wired up. The panel
    // renders a setup note instead of a failure.
    return Response.json({ configured: false }, { status: 200 })
  }

  const { searchParams } = new URL(req.url)
  // The cost report is daily-only and the usage report caps 1d buckets at 31,
  // so 31 is the ceiling for both regardless of what the dashboard asks for.
  const days = Math.min(Math.max(Number(searchParams.get('days') ?? 30), 1), 31)

  const cacheKey = `${days}`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < TTL_MS) {
    return Response.json({ ...(hit.body as object), cached: true })
  }

  // Whole-day boundaries in UTC. Asking for a partial trailing day is allowed
  // but makes the last bar look like a cliff, which reads as an outage.
  const end = new Date()
  end.setUTCHours(0, 0, 0, 0)
  end.setUTCDate(end.getUTCDate() + 1)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - days)

  const window = {
    starting_at: start.toISOString(),
    ending_at: end.toISOString(),
  }

  try {
    const usageParams = new URLSearchParams({ ...window, bucket_width: '1d', limit: '31' })
    usageParams.append('group_by[]', 'model')
    const costParams = new URLSearchParams({ ...window, limit: '31' })
    costParams.append('group_by[]', 'description')
    if (SCOPED_KEY_ID) {
      usageParams.append('api_key_ids[]', SCOPED_KEY_ID)
      // The cost report has no api_key filter — cost is always org-wide.
      // The dashboard labels it accordingly rather than pretending otherwise.
    }

    const [usage, cost] = await Promise.all([
      paginate<UsageBucket>('usage_report/messages', usageParams, adminKey),
      paginate<CostBucket>('cost_report', costParams, adminKey),
    ])

    // Per the API docs, cost amounts are decimal strings denominated in cents.
    // Parsed defensively: a NaN here would silently render as $NaN, and a
    // dashboard that shows a broken number is worse than one that shows zero.
    const centsToDollars = (amount: string) => {
      const n = Number(amount)
      return Number.isFinite(n) ? n / 100 : 0
    }

    const dailyCost = cost
      .map(b => ({
        date: b.starting_at.slice(0, 10),
        cost: (b.results ?? []).reduce((sum, r) => sum + centsToDollars(r.amount), 0),
      }))
      .sort((a, b) => a.date.localeCompare(b.date))

    const dailyTokens = usage
      .map(b => {
        const r = b.results ?? []
        const sum = (f: (x: UsageBucket['results'][number]) => number | undefined) =>
          r.reduce((acc, x) => acc + (f(x) ?? 0), 0)
        return {
          date: b.starting_at.slice(0, 10),
          input: sum(x => x.uncached_input_tokens),
          cacheRead: sum(x => x.cache_read_input_tokens),
          cacheWrite: sum(x => x.cache_creation_input_tokens),
          output: sum(x => x.output_tokens),
        }
      })
      .sort((a, b) => a.date.localeCompare(b.date))

    // Model split, flattened across buckets — answers "what am I actually
    // paying for", which the per-day view can't.
    const byModelMap = new Map<string, { input: number; output: number; cacheRead: number }>()
    for (const b of usage) {
      for (const r of b.results ?? []) {
        const model = r.model ?? 'unknown'
        const prev = byModelMap.get(model) ?? { input: 0, output: 0, cacheRead: 0 }
        prev.input += r.uncached_input_tokens ?? 0
        prev.output += r.output_tokens ?? 0
        prev.cacheRead += r.cache_read_input_tokens ?? 0
        byModelMap.set(model, prev)
      }
    }
    const byModel = [...byModelMap.entries()]
      .map(([model, t]) => ({ model, ...t }))
      .sort((a, b) => b.input + b.output - (a.input + a.output))

    const totals = dailyTokens.reduce(
      (acc, d) => ({
        input: acc.input + d.input,
        output: acc.output + d.output,
        cacheRead: acc.cacheRead + d.cacheRead,
        cacheWrite: acc.cacheWrite + d.cacheWrite,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    )

    const body = {
      configured: true,
      days,
      scopedToKey: Boolean(SCOPED_KEY_ID),
      totalCost: dailyCost.reduce((s, d) => s + d.cost, 0),
      totals,
      // Share of input tokens served from cache — the single most useful
      // efficiency number here, and one our own logging can't produce.
      cacheHitRate:
        totals.input + totals.cacheRead > 0
          ? totals.cacheRead / (totals.input + totals.cacheRead)
          : null,
      dailyCost,
      dailyTokens,
      byModel,
      cached: false,
    }

    cache.set(cacheKey, { at: Date.now(), body })
    return Response.json(body)
  } catch (e) {
    // A failure here must not take the dashboard down with it — the panel
    // shows the reason and everything else on the page still renders.
    return Response.json(
      { configured: true, error: e instanceof Error ? e.message : 'Usage lookup failed' },
      { status: 200 },
    )
  }
}
