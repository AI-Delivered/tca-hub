import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

const DEFAULT_CHIPS = [
  'When does school start?',
  "What's the dress code?",
  'How do I report an absence?',
  'What time does school end?',
  'Staff directory',
  'School supply lists',
]

export async function GET() {
  const supabase = getSupabaseAdmin()
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from('query_log')
    .select('query')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(500)

  if (error || !data?.length) {
    return NextResponse.json({ chips: DEFAULT_CHIPS })
  }

  // Count frequencies, filter short/junk queries
  const counts: Record<string, number> = {}
  for (const { query } of data) {
    const q = query.trim()
    if (q.length < 8) continue
    counts[q] = (counts[q] ?? 0) + 1
  }

  const trending = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([q]) => q)

  // Pad with defaults if fewer than 6 trending
  const chips = trending.length >= 3 ? trending : DEFAULT_CHIPS

  return NextResponse.json({ chips })
}
