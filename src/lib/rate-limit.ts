// Rate limiting for the public endpoints.
//
// /api/search is unauthenticated and every call spends real money: an embedding,
// a vector search, and a full generation. Before this, a single loop from one
// laptop could run the Anthropic bill up all night with nobody watching. The
// same is true of /api/track-visit, which inserts a database row per call.
//
// Two tiers, because neither is sufficient alone:
//   - a per-instance sliding window, which is exact and free, and catches the
//     realistic case (one client hammering one endpoint, served by one or two
//     warm instances);
//   - the Vercel runtime cache, shared across instances, which catches a caller
//     spread across instances. It isn't atomic, so a determined attacker can
//     race a few extra requests through — it narrows the window, it doesn't
//     close it. Platform-level protection is the answer to a real flood.
//
// Both fail open. A parent asking about the bell schedule should never see an
// error because the cache was briefly unavailable.

import { getCache } from '@vercel/functions'

interface Window {
  hits: number[]
}

const windows = new Map<string, Window>()
let lastSweep = 0

// Bounded so a stream of unique keys (spoofed forwarded-for headers) can't grow
// the map without limit.
const MAX_TRACKED_KEYS = 10_000

function sweep(now: number, windowMs: number) {
  if (now - lastSweep < 60_000) return
  lastSweep = now
  for (const [key, win] of windows) {
    if (!win.hits.some(t => now - t < windowMs)) windows.delete(key)
  }
  if (windows.size > MAX_TRACKED_KEYS) windows.clear()
}

export interface RateLimitResult {
  ok: boolean
  /** Seconds until the caller may retry. Only meaningful when `ok` is false. */
  retryAfter: number
  remaining: number
}

export interface RateLimitOptions {
  /** Distinct bucket per endpoint, so a burst of visits doesn't lock out search. */
  name: string
  limit: number
  windowMs: number
  /** Skip the shared tier for hot paths where a cache round trip isn't worth it. */
  shared?: boolean
}

/** Best-effort client identity. Spoofable, which is why the limits are generous. */
export function clientKey(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')
  const ip =
    req.headers.get('x-real-ip') ??
    forwarded?.split(',')[0]?.trim() ??
    'unknown'
  return ip.slice(0, 64)
}

export async function rateLimit(
  req: Request,
  { name, limit, windowMs, shared = true }: RateLimitOptions,
): Promise<RateLimitResult> {
  const now = Date.now()
  const key = `${name}:${clientKey(req)}`

  sweep(now, windowMs)

  const win = windows.get(key) ?? { hits: [] }
  win.hits = win.hits.filter(t => now - t < windowMs)

  if (win.hits.length >= limit) {
    windows.set(key, win)
    const oldest = win.hits[0]
    return {
      ok: false,
      retryAfter: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)),
      remaining: 0,
    }
  }

  win.hits.push(now)
  windows.set(key, win)

  if (shared) {
    try {
      const cache = getCache()
      const cacheKey = `rl:${key}:${Math.floor(now / windowMs)}`
      const count = ((await cache.get(cacheKey)) as number | undefined) ?? 0
      if (count >= limit) {
        return { ok: false, retryAfter: Math.ceil(windowMs / 1000), remaining: 0 }
      }
      await cache.set(cacheKey, count + 1, { ttl: Math.ceil(windowMs / 1000) * 2, name: 'tca-rate-limit' })
    } catch {
      // Cache unavailable — the per-instance window above is still enforcing.
    }
  }

  return { ok: true, retryAfter: 0, remaining: limit - win.hits.length }
}

export function tooManyRequests(result: RateLimitResult, message: string): Response {
  return Response.json(
    { error: message },
    {
      status: 429,
      headers: {
        'Retry-After': String(result.retryAfter),
        'Cache-Control': 'no-store',
      },
    },
  )
}
