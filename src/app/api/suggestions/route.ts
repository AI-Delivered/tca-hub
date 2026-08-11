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

/* Questions nobody has asked yet.
 *
 * The two existing sources both look backwards: the logs offer what parents
 * have already asked, and the seeds are a fixed list written by hand. Between
 * them they cover almost none of the questions this app can actually answer,
 * because most of those are a shape crossed with a thing — "does X have
 * practice today" for each of fifteen sports, "what time does X start" for each
 * of seven campuses. A parent typing "does volleyball" got nothing, not because
 * the answer was missing but because no one had asked it twice before.
 *
 * So the shapes are crossed with the entities the corpus actually holds, and
 * only those. That last part is the whole discipline of this file — a
 * suggestion is a promise that pressing enter works — so a sport with no
 * schedule in the corpus is never offered, however common the question.
 */
const SPORT_QUESTIONS = [
  (s: string) => `does ${s} have practice today?`,
  (s: string) => `when is the next ${s} game?`,
  (s: string) => `when does ${s} practice start?`,
  (s: string) => `what is the ${s} schedule?`,
]

const CAMPUS_QUESTIONS = [
  (c: string) => `what time does ${c} start?`,
  (c: string) => `what time does ${c} end?`,
  (c: string) => `who is the ${c} principal?`,
]

// The vocabulary a parent would type, not the site's team naming. "TCA
// Athletics — Girls Flag Football Junior Varsity (Girls)" is a chunk title;
// "flag football" is what somebody types.
const SPORT_VOCAB = [
  'football', 'flag football', 'basketball', 'soccer', 'volleyball', 'baseball',
  'softball', 'track', 'cross country', 'wrestling', 'lacrosse', 'tennis',
  'golf', 'cheer', 'swimming',
]

const CAMPUS_VOCAB = [
  'high school', 'junior high', 'college pathways', 'cottage school',
  'east elementary', 'central elementary', 'north elementary',
]

/** Sports the corpus has schedule data for, judged from the athletics titles. */
function sportsWithData(titles: string[]): string[] {
  const haystack = titles.join(' | ').toLowerCase()
  return SPORT_VOCAB.filter(s => haystack.includes(s))
}

export async function GET() {
  const supabase = getSupabaseAdmin()
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  // Which sports actually have a schedule in the corpus right now. Cheap — the
  // athletics chunks are titled, so this reads titles, not content.
  const { data: athleticsRows } = await supabase
    .from('page_chunks')
    .select('title')
    .ilike('title', 'TCA Athletics — %')
    // Ordered: `LIMIT` with no `ORDER BY` returns any 200 rows Postgres likes, so
    // which sports were found to "have data" — and therefore which questions were
    // offered — changed between page loads.
    .order('id')
    .limit(200)
  const generated = [
    ...sportsWithData([...new Set((athleticsRows ?? []).map(r => r.title as string))])
      .flatMap(sport => SPORT_QUESTIONS.map(q => q(sport))),
    ...CAMPUS_VOCAB.flatMap(campus => CAMPUS_QUESTIONS.map(q => q(campus))),
  ]

  const { data, error } = await supabase
    .from('query_log')
    .select('query, had_results, top_similarity')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(4000)

  if (error) {
    console.error('suggestions query failed:', error.message)
    return NextResponse.json(
      { suggestions: [...generated, ...SEED_SUGGESTIONS] },
      { headers: { 'Cache-Control': CACHE_HEADER } }
    )
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

  /* Real questions first — they're what people are actually asking this week —
   * then the generated ones, then the hand-written seeds.
   *
   * Order is the ranking: the browser takes the first entry whose text starts
   * with what has been typed, so whatever comes first wins the prefix. Logged
   * questions deserve that: if parents phrase it a particular way, complete to
   * their phrasing rather than to a template's.
   *
   * Two entries are duplicates when they mean the same thing *and* one is a
   * prefix of the other — "when is fall break" from the logs against "when is
   * fall break?" from the seeds, which used to complete the first and then
   * offer "?" as a second suggestion.
   *
   * Same meaning but a different opening is not a duplicate, it is a second way
   * in. Deduping those on meaning alone quietly cost coverage: the logs have
   * "Who is the principal of North Elementary?", so the generated "who is the
   * north elementary principal?" was dropped, and a parent typing "who is the
   * north" matched nothing at all.
   */
  const byKey = new Map<string, string[]>()
  const suggestions: string[] = []
  for (const s of [...popular, ...generated, ...SEED_SUGGESTIONS]) {
    const key = queryKey(s) || s.toLowerCase()
    const kept = byKey.get(key) ?? []
    const lower = s.toLowerCase()
    if (kept.some(k => k.startsWith(lower) || lower.startsWith(k))) continue
    kept.push(lower)
    byKey.set(key, kept)
    suggestions.push(s)
  }

  return NextResponse.json({ suggestions }, { headers: { 'Cache-Control': CACHE_HEADER } })
}
