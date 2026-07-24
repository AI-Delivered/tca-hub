import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  const { path, referrer, visitorId } = await req.json().catch(() => ({}))
  if (!path || typeof path !== 'string') {
    return Response.json({ error: 'path required' }, { status: 400 })
  }

  const supabase = getSupabaseAdmin()
  await supabase.from('page_visits').insert({
    path: path.slice(0, 200),
    referrer: typeof referrer === 'string' ? referrer.slice(0, 500) : null,
    visitor_id: typeof visitorId === 'string' ? visitorId.slice(0, 100) : null,
  })

  return new Response(null, { status: 204 })
}
