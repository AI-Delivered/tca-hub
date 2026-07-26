import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { rateLimit } from '@/lib/rate-limit'

// A UUID from crypto.randomUUID() on the client. Anything else is either a bug
// or someone hand-crafting rows, and neither belongs in the visitor count.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function POST(req: NextRequest) {
  // This endpoint writes a database row per call with no authentication. A
  // generous ceiling still bounds what one client can do to the table — and to
  // the visitor numbers the dashboard reports.
  const limit = await rateLimit(req, { name: 'visit', limit: 30, windowMs: 60_000, shared: false })
  if (!limit.ok) return new Response(null, { status: 204 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'Invalid request' }, { status: 400 })
  }
  const { path, referrer, visitorId } = body as { path?: unknown; referrer?: unknown; visitorId?: unknown }

  // Only same-origin paths — the analytics are about this app, and whatever
  // lands here is later rendered in the dashboard.
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    return Response.json({ error: 'path required' }, { status: 400 })
  }

  const supabase = getSupabaseAdmin()
  const { error } = await supabase.from('page_visits').insert({
    path: path.slice(0, 200),
    referrer: typeof referrer === 'string' ? referrer.slice(0, 500) : null,
    visitor_id: typeof visitorId === 'string' && UUID_RE.test(visitorId) ? visitorId : null,
  })
  if (error) console.error('page_visits insert failed:', error.message)

  return new Response(null, { status: 204 })
}
