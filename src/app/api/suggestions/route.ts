import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { queryKey } from '@/lib/query-key'

// Completions for the search box. Sent once per page load and matched in the
// browser, rather than a request per keystroke — a few kilobytes of strings
// beats putting a database query behind every letter a parent types.
export const revalidate = 600

const CACHE_HEADER = 'public, s-maxage=600, stale-while-revalidate=3600'

// Seeds, so the box completes usefully on day one and for prefixes the logs
// have never seen. Written the way a parent types, lower case and all.
const SEED_SUGGESTIONS = [
  'when does school start?',
  'when is the first day of school?',
  'what time does school start?',
  'what time does school end?',
  'what is the dress code?',
  'how do I report an absence?',
  'where is the staff directory?',
  'what are the school supply lists?',
  'what is the bell schedule?',
  'when is winter break?',
  'when is spring break?',
  'when is fall break?',
  'when is thanksgiving break?',
  'what days are there no school?',
  'who is the high school principal?',
  'who is the junior high principal?',
  'what is the lunch menu this week?',
  'how do I get a parking permit?',
  'when are parent teacher conferences?',
  'what time is dismissal?',
  'how do I enroll at TCA?',
  'when is picture day?',
  'what sports does TCA offer?',
  'when is the next football game?',
  'when is the next basketball game?',
  'where is the student handbook?',
]

// Queries that mention an email address, or that are long enough to be a
// sentence about a specific child rather than a question about the school.
const PERSONAL_RE = /@|\bmy (son|daughter|kid|child)\b.{20,}/i

export async function GET() {
  const supabase = getSupabaseAdmin()
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from('query_log')
    .select('query, had_results, top_similarity')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(4000)

  if (error) {
    console.error('suggestions query failed:', error.message)
    return NextResponse.json({ suggestions: SEED_SUGGESTIONS }, { headers: { 'Cache-Control': CACHE_HEADER } })
  }

  // Grouped on the canonical form so "Whos the MS principal" and "who is the
  // junior high principal" are one entry, and the wording offered back is
  // whichever version parents actually type most.
  const groups = new Map<string, { count: number; variants: Map<string, number> }>()
  for (const row of data ?? []) {
    const q = row.query?.trim()
    if (!q || q.length < 8 || q.length > 60) continue

    // Never complete to a question the app answers badly. A suggestion is a
    // promise that pressing enter works.
    if (row.had_results === false) continue
    if ((row.top_similarity ?? 1) < 0.6) continue
    if (PERSONAL_RE.test(q)) continue

    const key = queryKey(q)
    if (!key) continue
    const group = groups.get(key) ?? { count: 0, variants: new Map<string, number>() }
    group.count++
    group.variants.set(q, (group.variants.get(q) ?? 0) + 1)
    groups.set(key, group)
  }

  // Two occurrences minimum. These are other people's questions being shown
  // back to a stranger, and the threshold is what makes that safe: a question
  // only one person has ever asked — the kind that might carry a child's name
  // or a family's situation — is never offered to anybody else.
  const popular = [...groups.values()]
    .filter(g => g.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 150)
    .map(g => [...g.variants.entries()].sort((a, b) => b[1] - a[1])[0][0])

  // Real questions first — they're what people are actually asking this week —
  // with the seeds behind them to cover the gaps.
  //
  // Deduped on the canonical form, not the literal string: "when is fall break"
  // from the logs and "when is fall break?" from the seeds are one question, and
  // keeping both meant the box completed the first and then offered "?" as a
  // second suggestion.
  const seen = new Set<string>()
  const suggestions: string[] = []
  for (const s of [...popular, ...SEED_SUGGESTIONS]) {
    const key = queryKey(s) || s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    suggestions.push(s)
  }

  return NextResponse.json({ suggestions }, { headers: { 'Cache-Control': CACHE_HEADER } })
}
