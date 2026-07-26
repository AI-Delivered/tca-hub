import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { queryKey } from '@/lib/query-key'

// What's trending changes over days, not seconds, and this ran on every single
// page load — a 500-row scan per visitor to compute an answer that was
// identical for all of them. Ten minutes of caching at the edge makes the
// common case a static response.
export const revalidate = 600

const DEFAULT_CHIPS = [
  'When does school start?',
  "What's the dress code?",
  'How do I report an absence?',
  'What time does school end?',
  'Staff directory',
  'School supply lists',
]

const CACHE_HEADER = 'public, s-maxage=600, stale-while-revalidate=3600'

export async function GET() {
  const supabase = getSupabaseAdmin()
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from('query_log')
    .select('query, had_results, top_similarity')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(500)

  if (error || !data?.length) {
    if (error) console.error('trending query failed:', error.message)
    return NextResponse.json({ chips: DEFAULT_CHIPS }, { headers: { 'Cache-Control': CACHE_HEADER } })
  }

  // Grouped on the canonical form, the same way the dashboard groups them, so
  // "Whos the MS principal" and "who is the junior high principal" are one
  // suggestion rather than two — and the wording shown is whichever version
  // most parents actually typed.
  const groups = new Map<string, { count: number; variants: Map<string, number> }>()
  for (const row of data) {
    const q = row.query?.trim()
    if (!q || q.length < 8 || q.length > 42) continue
    // Never suggest a question the app is known to answer badly. A chip is a
    // promise that tapping it works.
    if (row.had_results === false) continue
    if ((row.top_similarity ?? 1) < 0.6) continue

    const key = queryKey(q)
    if (!key) continue
    const group = groups.get(key) ?? { count: 0, variants: new Map<string, number>() }
    group.count++
    group.variants.set(q, (group.variants.get(q) ?? 0) + 1)
    groups.set(key, group)
  }

  const trending = [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map(g => [...g.variants.entries()].sort((a, b) => b[1] - a[1])[0][0])

  const chips = trending.length >= 3 ? trending : DEFAULT_CHIPS

  return NextResponse.json({ chips }, { headers: { 'Cache-Control': CACHE_HEADER } })
}
