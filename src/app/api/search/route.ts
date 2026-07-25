import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export const maxDuration = 60

// Parents don't speak the website's dialect: they say "middle school" where every
// chunk says "Junior High", so the embedding has nothing to latch onto and the
// wrong campus comes back. Append the site's own wording before embedding.
const SYNONYM_EXPANSIONS: Array<[RegExp, string]> = [
  [/middle school|\bjh\b|(7th|8th|seventh|eighth)\s+grade/i, 'Junior High'],
  [/\bhs\b|freshman|sophomore|(9th|10th|11th|12th)\s+grade/i, 'High School'],
  [/\bcp\b/i, 'College Pathways'],
]

// Campus named in a query. Junior High is tested before High School so
// "junior high school" doesn't land on HS.
const CAMPUS_ALIASES: Array<[RegExp, string]> = [
  [/junior high|middle school|\bjh\b|(7th|8th|seventh|eighth) grade/i, 'Junior High'],
  [/college pathways|\bcp\b/i, 'College Pathways'],
  [/cottage/i, 'Cottage School'],
  [/high school|\bhs\b|freshman|sophomore|(9th|10th|11th|12th) grade/i, 'High School'],
  [/\beast\b/i, 'East Elementary'],
  [/\bcentral\b/i, 'Central Elementary'],
  [/\bnorth\b/i, 'North Elementary'],
]

const STAFF_QUERY_RE = /principal|teacher|teaches|counsel|dean|nurse|secretar|registrar|librarian|coach|director|superintendent|paraprofessional|\bpara\b|\baide\b|specialist|psychologist|therapist|pathologist|custodian|bookkeeper|receptionist|front office|faculty|instructor|staff|who works/i
const LEADERSHIP_RE = /principal|dean|counsel|director|head of school|superintendent/i

// The name regex used for keyword retrieval is case-insensitive, so "who is the
// principal at East" captures "the principal at East" — a role question wearing a
// name's clothes. Only treat a capture as a person when it holds no role or campus
// words, otherwise the role path never gets a chance to run.
const NON_NAME_RE = /\b(principal|teacher|teaches|counsel\w*|dean|nurse|secretar\w*|registrar|librarian|coach|director|superintendent|para\w*|aide|specialist|psychologist|therapist|pathologist|custodian|bookkeeper|receptionist|office|faculty|instructor|staff|school|elementary|junior|middle|high|college|pathways|cottage|east|central|north|grade|kinder\w*|the|my|our|an?)\b/i

// Words that identify a campus rather than a role — they gate which staff cards
// are eligible, so they must not also score them.
const CAMPUS_WORDS = new Set(['east', 'central', 'north', 'elementary', 'junior', 'high', 'middle', 'jh', 'hs', 'cp', 'college', 'pathways', 'cottage', 'campus'])
const STAFF_STOPWORDS = new Set([
  'who', 'is', 'are', 'the', 'a', 'an', 'at', 'for', 'of', 'in', 'to', 'my', 'me', 'i',
  'what', 'whats', 'email', 'contact', 'address', 'name', 'tell', 'about', 'can', 'you',
  'give', 'list', 'please', 'need', 'and', 'with', 'does', 'do', 'their', 'there', 'his',
  'her', 'they', 'how', 'get', 'reach', 'send', 'anyone', 'someone', 'which', 'school',
  'tca', 'titans', 'info', 'information', 'phone', 'number', 'looking', 'find', 'this',
  'that', 'have', 'has', 'know', 'kid', 'kids', 'child', 'student', 'grader',
  // "who works at East" is a whole-directory ask, not a role — let it fall through
  // to the leadership fallback instead of matching "Social Worker"
  'work', 'works', 'working', 'worker',
])
const ORDINALS: Record<string, string> = {
  kindergarten: 'kinder', first: '1st', second: '2nd', third: '3rd', fourth: '4th',
  fifth: '5th', sixth: '6th', seventh: '7th', eighth: '8th',
}

// "teachers" and "teaches" both need to hit the role "5th Grade Teacher"
function stem(token: string): string {
  if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2)
  if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1)
  return token
}

// Score, not a boolean: "Principal" should outrank "Assistant Principal" when the
// query asks for the principal.
function roleScore(role: string, token: string): number {
  const r = role.toLowerCase()
  const s = stem(token)
  if (!r.includes(token) && !r.includes(s)) return 0
  return r.startsWith(token) || r.startsWith(s) ? 1.5 : 1
}

// Whole-word match. Plain `includes` routed "what is the atten(dance) policy" to the
// athletics chunks, "PTO (meet)ing" likewise, and "at (least)" would read as East.
function hasTerm(text: string, term: string): boolean {
  return new RegExp(`\\b${term}\\b`, 'i').test(text)
}

// Sport words that make a question an athletics question on their own. "match" and
// "meet" are deliberately absent: as bare words they're far more often ordinary
// English ("match my student to a teacher", "PTO meeting") than sports, and real
// uses — "volleyball match", "track meet" — already carry a sport name.
const SPORT_NAMES = [
  'football', 'basketball', 'soccer', 'volleyball', 'baseball', 'softball',
  'track', 'swim', 'cross country', 'wrestling', 'lacrosse', 'tennis', 'golf', 'cheer', 'dance',
]
const SPORT_TERMS = [
  ...SPORT_NAMES,
  'scrimmage', 'game', 'games', 'tournament', 'playoff', 'playoffs', 'championship',
  'tryout', 'tryouts', 'practice', 'athletics', 'sport', 'sports',
]

const CAL_EVENT_TERMS = [
  'literacy testing', 'picture day', 'field trip', 'open house', 'back to school',
  'parent teacher', 'conference', 'curriculum night', 'grandparent', 'fall festival',
  'spring fling', 'book fair', 'spirit week', 'talent show', 'science fair',
  'kindergarten', 'early out', 'early release', 'no school', 'teacher inservice',
  'teacher workday', 'work day', 'professional development', 'pd day', 'inservice day',
  'first day', 'last day', 'winter break', 'spring break', 'fall break', 'thanksgiving',
  'christmas', 'halloween', 'valentines', 'auction', 'carnival',
  'mlk', 'martin luther king', 'presidents day', 'labor day', 'memorial day',
  'veterans day', 'columbus day', 'holiday',
  ...SPORT_TERMS,
]

// "when do the play(off)s start" and "when is the (off)ice open" both used to read as
// days-off questions, which also suppressed the athletics and calendar paths below.
const DAYS_OFF_RE = /days off|day off|school calendar|no.school days|holidays|\bdays? (out|closed)\b|when.*\b(off|closed|break)\b|schedule for the year|teacher work|workday|inservice|professional development|pd day|halloween|thanksgiving|christmas|winter break|spring break|fall break|no school/i
// Arrival and dismissal are carpool questions, not "is there school that day" questions
const CARPOOL_RE = /\b(drop[\s-]?off|pick[\s-]?up|carpool|car line|kiss and go|dismissal)\b/i

const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december']

// TCA runs on Mountain Time; the server doesn't.
function denverNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }))
}

// The school year runs August–June. Derived from today rather than hardcoded:
// a pinned 2026-27 array meant that come July 2027 every month would fail the
// "is it still ahead of us" test and days-off questions would quietly return
// no calendar chunks at all.
function schoolYearStart(now: Date): number {
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1
}

function schoolYearMonths(now: Date): Array<[number, number]> {
  const start = schoolYearStart(now)
  const months: Array<[number, number]> = []
  for (let m = 7; m <= 11; m++) months.push([m, start])      // Aug–Dec
  for (let m = 0; m <= 5; m++) months.push([m, start + 1])   // Jan–Jun
  return months
}

// "October 2025" and "October 2024" chunks were being cited next to October 2026
// for the same question. Vector search has no sense of which year is current, so
// drop calendar chunks for months that have already passed.
function isStaleCalendarChunk(chunk: { url: string; title: string }, now: Date): boolean {
  if (!/-calendar/.test(chunk.url)) return false
  const match = `${chunk.url} ${chunk.title}`.toLowerCase().match(/(january|february|march|april|may|june|july|august|september|october|november|december)[\s—-]+(20\d{2})/)
  if (!match) return false
  const month = MONTH_NAMES.indexOf(match[1])
  const year = Number(match[2])
  return year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth())
}

const CALENDAR_CAMPUS_MAP: Record<string, string> = {
  'east': 'east-elementary-calendar',
  'central': 'central-elementary-calendar',
  'north': 'north-elementary-calendar',
  'junior high': 'junior-high-calendar',
  'jh': 'junior-high-calendar',
  'high school': 'high-school-calendar',
  'college pathways': 'college-pathways-calendar',
  'cp': 'college-pathways-calendar',
}

export async function POST(req: NextRequest) {
  const requestStart = Date.now()
  const now = denverNow()
  const nowYear = now.getFullYear()
  const nowMonth = now.getMonth()
  const schoolYearLabel = `${schoolYearStart(now)}-${String(schoolYearStart(now) + 1).slice(2)}`
  const { query, rawQuery, history = [] } = await req.json()
  if (!query?.trim()) {
    return Response.json({ error: 'Query required' }, { status: 400 })
  }

  const [{ VoyageAIClient }, { default: Anthropic }] = await Promise.all([
    import('voyageai'),
    import('@anthropic-ai/sdk'),
  ])

  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const supabase = getSupabaseAdmin()

  // Augment retrieval query with last user turn so follow-up questions inherit context
  const lastUserMsg = (history as { role: string; content: string }[]).filter(m => m.role === 'user').slice(-1)[0]?.content ?? ''
  const baseQuery = lastUserMsg ? `${lastUserMsg} ${query}` : query
  const expansions = SYNONYM_EXPANSIONS.filter(([re]) => re.test(baseQuery)).map(([, term]) => term)
  const retrievalQuery = expansions.length ? `${baseQuery} ${expansions.join(' ')}` : baseQuery
  const embeddingRes = await voyage.embed({ input: [retrievalQuery.slice(0, 16000)], model: 'voyage-3-lite' })
  const queryEmbedding = embeddingRes.data![0].embedding!

  const { data: chunks, error } = await supabase.rpc('match_chunks', {
    query_embedding: queryEmbedding,
    match_count: 16,
  })

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  // Keyword fallback: name-based queries may not score high on vector search
  // because staff directories contain 50-90 names and the embedding is diluted.
  // Handles: "who is Sean Shields", "Mr. Walters", "Mrs. Smith", "tell me about Coach Jones"
  type Chunk = { url: string; title: string; content: string; similarity: number }

  // Trigram similarity in JS — same algorithm as pg_trgm
  function trigramSimilarity(a: string, b: string): number {
    const trigrams = (s: string) => {
      const padded = `  ${s.toLowerCase()}  `
      const set = new Set<string>()
      for (let i = 0; i < padded.length - 2; i++) set.add(padded.slice(i, i + 3))
      return set
    }
    const ta = trigrams(a), tb = trigrams(b)
    let shared = 0
    for (const t of ta) if (tb.has(t)) shared++
    return (2 * shared) / (ta.size + tb.size)
  }

  let keywordChunks: Chunk[] = []
  const nameMatch =
    query.match(/who\s+is\s+(?:mr\.?|mrs\.?|ms\.?|miss\.?|dr\.?|coach\.?)?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i) ||
    query.match(/(?:mr\.?|mrs\.?|ms\.?|miss\.?|dr\.?|coach\.?)\s+([A-Z][a-z]+)/i) ||
    query.match(/(?:about|find|contact|email)\s+(?:mr\.?|mrs\.?|ms\.?|miss\.?|dr\.?|coach\.?)?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i)
  if (nameMatch) {
    const name = nameMatch[1].trim()
    // Exact match first
    const { data: exactRows } = await supabase
      .from('page_chunks')
      .select('url, title, content')
      .ilike('url', '%staff-directory%')
      .ilike('content', `%${name}%`)
      .limit(8)
    keywordChunks = (exactRows ?? []).map(c => ({ ...c, similarity: 0.6 }))

    // If exact match found nothing, try fuzzy: fetch all staff chunks and score by trigram similarity
    if (keywordChunks.length === 0) {
      const { data: allStaffRows } = await supabase
        .from('page_chunks')
        .select('url, title, content')
        .ilike('url', '%staff-directory%')
        .limit(60)
      // Split searched name into parts so "Matt Brunk" scores "Matt"↔"Matthew" and "Brunk"↔"Brunk"
      const nameParts = name.toLowerCase().split(/\s+/).filter((p: string) => p.length >= 3)
      const fuzzyMatches = (allStaffRows ?? [])
        .map(c => {
          const words = c.content.match(/[A-Z][a-z]{2,}/g) ?? []
          const partScores = nameParts.map((part: string) =>
            Math.max(0, ...words.map((w: string) => trigramSimilarity(part, w.toLowerCase())))
          )
          const avgScore = partScores.length ? partScores.reduce((a: number, b: number) => a + b, 0) / partScores.length : 0
          return { ...c, similarity: avgScore }
        })
        .filter(c => c.similarity >= 0.4)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 8)
      keywordChunks = fuzzyMatches
    }
  }

  // Staff question about a named campus — resolved here rather than left to the
  // embedding. Every campus has near-identical "<Campus> — <Category>" chunks
  // competing for the top-16 slots, so "who's the middle school principal" can
  // come back with Central Elementary's leadership and nothing from JH.
  const rawName = nameMatch?.[1]?.trim() ?? ''
  const personName = rawName && !NON_NAME_RE.test(rawName) ? rawName : null
  const wantCampus = CAMPUS_ALIASES.find(([re]) => re.test(query))?.[1] ?? null
  const roleTokens: string[] = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((t: string) => ORDINALS[t] ?? t)
    .filter((t: string) => t.length > 1 && !STAFF_STOPWORDS.has(t) && !CAMPUS_WORDS.has(t))

  if (!personName && wantCampus && STAFF_QUERY_RE.test(query)) {
    // Pull the campus chunks that actually mention the role asked about; fall back
    // to that campus's leadership for broad "who works at X" asks.
    const roleAnchor = roleTokens.find(t => t.length > 2)
    const anchorQuery = supabase
      .from('page_chunks')
      .select('url, title, content')
      .ilike('url', '%staff-directory%')
      .ilike('title', `${wantCampus} — %`)
    const { data: campusRows } = roleAnchor
      ? await anchorQuery.ilike('content', `%${stem(roleAnchor)}%`).limit(4)
      : await anchorQuery.ilike('title', '%Leadership%').limit(2)
    keywordChunks = [...keywordChunks, ...(campusRows ?? []).map(c => ({ ...c, similarity: 0.7 }))]
  }

  // Broad "days off" queries — pull monthly calendar chunks for the current school year.
  // Only include months from the current month onward so the AI isn't confused by past events.
  const daysOffQuery = DAYS_OFF_RE.test(query) && !CARPOOL_RE.test(query)
  if (daysOffQuery) {
    const campusKey = Object.keys(CALENDAR_CAMPUS_MAP).find(k => hasTerm(query, k))
    const urlFilter = campusKey ? `%${CALENDAR_CAMPUS_MAP[campusKey]}%` : '%-calendar%'

    const futureMonthSlugs = schoolYearMonths(denverNow())
      .filter(([m, y]) => y > nowYear || (y === nowYear && m >= nowMonth))
      .map(([m, y]) => `%${MONTH_NAMES[m]}-${y}`)

    // Fetch all future months in parallel (one query per month-year slug, deduplicated by campus)
    // Use High School as the canonical source for school-wide no-school days; add others for campus-specific events
    const canonicalFilter = campusKey ? urlFilter : '%high-school-calendar%'
    const canonicalRows = await Promise.all(
      futureMonthSlugs.map(slug =>
        supabase.from('page_chunks').select('url, title, content').ilike('url', canonicalFilter).ilike('url', slug).limit(1)
      )
    )
    // If no campus specified, also pull elementary + JH chunks for campus-specific events
    const extraRows = campusKey ? [] : await Promise.all(
      futureMonthSlugs.flatMap(slug => [
        supabase.from('page_chunks').select('url, title, content').ilike('url', '%east-elementary-calendar%').ilike('url', slug).limit(1),
        supabase.from('page_chunks').select('url, title, content').ilike('url', '%junior-high-calendar%').ilike('url', slug).limit(1),
      ])
    )
    const allDaysOffRows = [
      ...canonicalRows.flatMap(r => r.data ?? []),
      ...extraRows.flatMap(r => r.data ?? []),
    ]
    const daysOffChunks = allDaysOffRows.map(c => ({ ...c, similarity: 0.72 }))
    keywordChunks = [...keywordChunks, ...daysOffChunks]
  }

  const isSportsQuery = !daysOffQuery && SPORT_TERMS.some(t => hasTerm(query, t))
  const calTermMatch = !daysOffQuery ? CAL_EVENT_TERMS.find(t => hasTerm(query, t)) : undefined

  // Named sports only (excludes generic words like "game"/"practice"/"tournament") — used to
  // anchor the specific per-team chunk by title. There are 60+ near-identically-worded
  // "TCA Athletics — <Sport> <Level> (<Gender>)" chunks competing for the vector search's
  // top-16 slots, so whether e.g. "Boys Track & Field Junior High" makes the cut for a plain
  // "when does track start" query is essentially a coin flip — the same query can surface it
  // one run and miss it the next. Anchor it by keyword the same way the Upcoming chunk is
  // anchored, instead of leaving it to embedding-ranking luck.
  const matchedSport = SPORT_NAMES.find(t => hasTerm(query, t))

  if (isSportsQuery) {
    // Always anchor sports queries with the GoBound upcoming chunk — it's the authoritative
    // aggregated view of all TCA athletics for the next 30 days with exact times.
    // Give it the highest priority so it wins over TeamReach or sport-specific chunks.
    // Fetch both GoBound upcoming chunks by exact title — avoids # encoding issues in ILIKE
    const [{ data: gbUpcoming }, { data: gbSchedule }, sportChunks] = await Promise.all([
      supabase.from('page_chunks').select('url, title, content').eq('title', 'TCA Athletics — Upcoming').limit(1),
      supabase.from('page_chunks').select('url, title, content').eq('title', 'TCA Athletics & Activities — Upcoming Schedule').limit(1),
      matchedSport
        ? supabase.from('page_chunks').select('url, title, content').ilike('title', 'TCA Athletics%').ilike('title', `%${matchedSport}%`).limit(20)
        : Promise.resolve({ data: [] }),
    ])
    const gbChunks = [...(gbUpcoming ?? []), ...(gbSchedule ?? [])].map(c => ({ ...c, similarity: 0.90 }))
    // Below the Upcoming anchor's 0.90 (so the 30-day view still wins on recency) but above
    // the 0.50 source-display threshold, so the sport-specific chunk always makes it into
    // context and is cited as a source.
    const sportSpecificChunks = (sportChunks.data ?? []).map(c => ({ ...c, similarity: 0.82 }))
    keywordChunks = [...gbChunks, ...sportSpecificChunks, ...keywordChunks]
  }

  if (calTermMatch && !isSportsQuery) {
    // Non-sports calendar keyword — search campus calendars
    const campusKey = Object.keys(CALENDAR_CAMPUS_MAP).find(k => hasTerm(query, k))
    const urlFilter = campusKey ? `%${CALENDAR_CAMPUS_MAP[campusKey]}%` : '%-calendar%'
    const { data: calRows } = await supabase
      .from('page_chunks')
      .select('url, title, content')
      .ilike('url', urlFilter)
      .ilike('content', `%${calTermMatch}%`)
      .order('url', { ascending: true })
      .limit(60)
    // Ordering is alphabetical by URL, so last year's months (…-april-2025) crowd
    // out this year's. Over-fetch, drop the stale ones, then take the top 20.
    const calChunks = (calRows ?? [])
      .filter(c => !isStaleCalendarChunk(c, now))
      .slice(0, 20)
      .map(c => ({ ...c, similarity: 0.65 }))
    keywordChunks = [...keywordChunks, ...calChunks]
  }

  // Merge: vector results first, then any keyword-only hits not already included.
  // Last year's calendar months are dropped here rather than at each fetch site,
  // so vector hits are covered too — they're the ones that surfaced October 2024
  // alongside October 2026 for the same question.
  const seenUrls = new Set((chunks ?? []).map((c: Chunk) => c.url))
  const merged: Chunk[] = [
    ...(chunks ?? []),
    ...keywordChunks.filter(c => !seenUrls.has(c.url)),
  ].filter(c => !isStaleCalendarChunk(c, now))

  const encoder = new TextEncoder()

  const send = (obj: unknown) => encoder.encode(JSON.stringify(obj) + '\n')

  if (!merged?.length) {
    const noResultsAnswer = "I couldn't find information about that on the TCA website. Try rephrasing your question or visit tcatitans.org directly."
    const logQuery = (rawQuery ?? query).trim().slice(0, 500)
    supabase.from('query_log').insert({
      query: logQuery,
      had_results: false,
      source_count: 0,
      top_similarity: null,
      model: null,
      latency_ms: Date.now() - requestStart,
      answer_preview: noResultsAnswer,
    }).then(() => {})

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(send({ type: 'sources', sources: [] }))
        controller.enqueue(send({ type: 'text', text: noResultsAnswer }))
        controller.enqueue(send({ type: 'done' }))
        controller.close()
      }
    })
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } })
  }

  // Staff photo cards — shown for any staff question, not just "who is <Name>".
  // Three shapes are handled: a specific person ("who is Mr. Walters"), a role
  // ("who's the principal at East"), and a group ("5th grade teachers at North").
  // Capped so a whole grade level doesn't bury the answer.
  const MAX_STAFF_CARDS = 6
  type StaffCard = { name: string; role: string; email: string; photo: string; campus: string }

  // Both staff chunk shapes: per-category lines ("Role: Name — email [photo:url]")
  // and the campus summary chunk ("Role: Name (email) [photo:url], Name2 (...)").
  function extractStaffEntries(chunk: Chunk): StaffCard[] {
    const lines = chunk.content.split('\n')
    const campus = (lines[0] ?? '').split('—')[0].replace(/staff directory/i, '').replace(/[:\s]+$/, '').trim()
    const entries: StaffCard[] = []
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(':')
      if (colon < 1) continue
      const role = line.slice(0, colon).trim()
      const rest = line.slice(colon + 1)
      if (!role || role.startsWith('(')) continue

      const single = rest.match(/^\s*(.+?)\s+—\s+([\w.]*@tcatitans\.org)\s*(?:\[photo:([^\]]+)\])?\s*$/)
      if (single) {
        entries.push({ name: single[1].trim(), role, email: single[2], photo: single[3] ?? '', campus })
        continue
      }
      for (const m of rest.matchAll(/([^,()]+?)\s+\(([\w.]*@tcatitans\.org|)\)\s*(?:\[photo:([^\]]+)\])?/g)) {
        const name = m[1].trim()
        if (name) entries.push({ name, role, email: m[2] ?? '', photo: m[3] ?? '', campus })
      }
    }
    return entries
  }

  let staffCards: StaffCard[] = []
  if (personName || STAFF_QUERY_RE.test(query)) {
    const seenCards = new Set<string>()
    const scored: Array<{ card: StaffCard; score: number }> = []
    const leadership: StaffCard[] = []

    for (const chunk of merged) {
      if (!chunk.url.includes('staff-directory')) continue
      for (const entry of extractStaffEntries(chunk)) {
        if (!entry.photo) continue // no headshot, no card
        const key = `${entry.name.toLowerCase()}|${entry.campus}`
        if (seenCards.has(key)) continue
        if (wantCampus && entry.campus && entry.campus !== wantCampus) continue
        seenCards.add(key)

        let score = 0
        if (personName && entry.name.toLowerCase().includes(personName.toLowerCase())) score += 10
        for (const t of roleTokens) score += roleScore(entry.role, t)
        // A named-person query shouldn't surface strangers who merely share a role word
        if (personName && score < 10) score = 0

        if (score > 0) scored.push({ card: entry, score })
        else if (!personName && LEADERSHIP_RE.test(entry.role)) leadership.push(entry)
      }
    }

    // Fallback for broad asks ("who works at East Elementary") — show the faces a
    // parent is most likely after rather than six arbitrary ones.
    const ranked = scored.length
      ? scored.sort((a, b) => b.score - a.score).map(s => s.card)
      : leadership
    staffCards = ranked.slice(0, MAX_STAFF_CARDS)
  }

  // Strip [photo:...] markers before sending context to AI
  const context = merged
    .map((c: { title: string; url: string; content: string }, i: number) =>
      `[Source ${i + 1}: ${c.title} (${c.url})]\n${c.content.replace(/\s*\[photo:[^\]]+\]/g, '')}`
    )
    .join('\n\n---\n\n')

  // Sources (filtered by similarity)
  const seen = new Set<string>()
  const sources = merged
    .filter((c: { url: string; similarity: number }) => {
      if (c.similarity < 0.50) return false
      if (seen.has(c.url)) return false
      seen.add(c.url)
      return true
    })
    .slice(0, 4)
    .map((c: { url: string; title: string }) => ({ url: c.url, title: c.title }))

  // Build conversation messages for Anthropic
  // Prior turns: clean query + answer text (no context injection)
  // Current turn: query + fresh context
  const anthropicMessages: { role: 'user' | 'assistant'; content: string }[] = [
    ...(history as { role: 'user' | 'assistant'; content: string }[]),
    {
      role: 'user',
      content: `Context from TCA website:\n\n${context}\n\nQuestion: ${query}`,
    },
  ]

  const systemPrompt = `You are a helpful assistant for TCA (The Classical Academy) in Colorado Springs. Be warm and conversational — like a knowledgeable friend who knows TCA inside and out. You do not know who the user is or which student they have. Never say "your team", "your student", "your child", or "your next game" unless they've explicitly told you their grade or campus in this conversation. Always refer to teams by name: "TCA football", "the JH A team", "TCA Volleyball Varsity", etc. If two calendar sources show different times for the same event, say so: "GoBound shows 8:30 AM; TeamReach lists it as tentative at 9:00 AM — confirm with the coach."

HARD RULE: Do not ask follow-up questions. Ever. Do not end with "Is there anything else I can help you with?", "Is that who you're looking for?", "Does that help?", or any question. Answer, then stop.

TCA campuses: Central Elementary, East Elementary, and North Elementary (K–6); one Junior High (grades 7–8); one High School (grades 9–12); plus College Pathways. There is only one JH and one HS — so questions about 7th/8th graders are automatically JH, 9th–12th are automatically HS. Elementary questions may need campus clarification (Central, East, or North).

Synonyms — treat all of these as identical: "Junior High" = "JH" = "middle school" = "7th grade" = "8th grade" = "seventh grade" = "eighth grade" = "grades 7-8". If a parent says "middle school" or "my 7th grader," that means Junior High. Carry campus/school context between turns: if the prior question was about Junior High, assume the next question is also about Junior High unless stated otherwise.

High school grade levels: 9th = Freshman, 10th = Sophomore, 11th = Junior, 12th = Senior. Understand and use these terms naturally — if a parent says "my freshman" treat it as 9th grade/High School, "my sophomore" as 10th grade/High School, etc.

Be smart about context: sports (football, basketball, soccer, wrestling, cheer, etc.), athletics schedules, and team-specific questions only apply to Junior High and High School — never mention elementary in those answers unless the parent specifically brings it up. Literacy testing (DIBELS, reading assessments, oral reading fluency, etc.) only applies to elementary campuses (Central, East, North) — never reference it for Junior High or High School. If the parent has a 5th grader and asks about football, answer for JH/HS and don't add a note about the elementary student.

Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Denver' })}. Current time is approximately ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver' })} Mountain Time. Current school year is ${schoolYearLabel}. A date is "past" only if it is before TODAY's date — today's events are current and valid to cite regardless of month. Never dismiss July or August events as "summer break" — TCA runs athletics, camps, and activities year-round including summer. If you only have a past date for a recurring annual event, say "Last year it was [date] — the ${schoolYearLabel} date hasn't been posted yet." Never call a future date "already passed."

Calendar data is authoritative: if the calendar context includes a month's events and a specific date in that month is NOT listed as a closure, no-school day, or break, then school IS in session on that date. You do not need to say "I'm not sure" — if you have the month's data and the date isn't listed as a closure, confidently say school is in session. Only express uncertainty if you don't have that month's calendar data at all.

Sports schedule accuracy rule: The schedule data comes from two sources — GoBound (authoritative, covers all TCA sports) and TeamReach (team-specific, may have different wording). When they conflict, GoBound wins. The "TCA Athletics — Upcoming" chunk is the most reliable source for times and dates. Rules:
1. Use the time from the GoBound upcoming chunk. If TeamReach says a different time or calls something "tentative," defer to GoBound.
2. When asked about a specific level, ONLY list dates/times from events tagged with that EXACT level.
3. [Football C-Squad (Boys)] events are C-Squad only. They are not Varsity. Never include them in a Varsity answer.
4. If no upcoming events appear in context, link to https://gobound.com/co/schools/theclassahs/calendar?v=list — never fabricate URLs.
5. Never extrapolate, assume, or pattern-match from other levels or days. Only cite explicit events.
6. If asked whether TCA has a specific sport and no schedule data exists in context, do NOT say the sport doesn't exist — say no events are showing yet and link to https://gobound.com/co/schools/theclassahs/calendar?v=list to confirm.

Answer style:
- Lead with the answer. No preamble ("Based on...", "According to...").
- **NEVER end with a question of any kind. The HARD RULE above is absolute — it overrides everything else. When in doubt: answer, then stop.**
- When a question could apply to multiple campuses or grade levels with no prior context, list the answer for each one briefly — do not ask which campus. E.g. "School ends at 3:30 PM at all three elementaries (Mon–Thu), 3:00 PM at JH, and 3:10 PM at HS." Asking is never the right move.
- 1–4 sentences for most things. Bullet points only for 3+ distinct items.
- Be direct and specific — "9th graders start on..." or "TCA football opens on..." rather than vague generalizations.
- If something's not in the context, say so in one sentence and link them somewhere useful (the staff directory, the TCA website, or a relevant campus page).
- Always include a direct URL as a markdown link when referencing a specific page or form.
- For staff contacts: if not in context, point them to the [staff directory](https://www.tcatitans.org/family/staff-directory).
- For lists (spelling words, supply lists, etc.): reproduce them completely, don't summarize.
- You're in a conversation — use prior context naturally. **Conversation context beats profile**: if the prior turn mentioned a specific campus or school, assume that campus for follow-up questions without clarifying.`

  const logQuery = (rawQuery ?? query).trim().slice(0, 500)
  const topSimilarity = merged.reduce((max: number, c: Chunk) => Math.max(max, c.similarity), 0)

  // Escalate to Sonnet only on the harder cases — weak retrieval match (model has to
  // synthesize/hedge across thin or conflicting sources) or a long multi-turn thread
  // (more context to track correctly). Everything else stays on Haiku.
  const isHardCase = topSimilarity < 0.55 || (history as unknown[]).length >= 6
  const MODEL = isHardCase ? 'claude-sonnet-5' : 'claude-haiku-4-5-20251001'

  // Stream the response
  const readableStream = new ReadableStream({
    async start(controller) {
      controller.enqueue(send({ type: 'sources', sources }))
      if (staffCards.length) controller.enqueue(send({ type: 'staffCards', staffCards }))

      let answerText = ''
      let usage: { input_tokens?: number; output_tokens?: number } = {}
      try {
        const stream = anthropic.messages.stream({
          model: MODEL,
          max_tokens: 1024,
          system: systemPrompt,
          messages: anthropicMessages,
        })

        for await (const event of stream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta' &&
            event.delta.text
          ) {
            answerText += event.delta.text
            controller.enqueue(send({ type: 'text', text: event.delta.text }))
          }
          if (event.type === 'message_delta' && event.usage) {
            usage = { ...usage, output_tokens: event.usage.output_tokens }
          }
          if (event.type === 'message_start') {
            usage = { ...usage, input_tokens: event.message.usage.input_tokens }
          }
        }
      } catch (e) {
        controller.enqueue(send({ type: 'error', message: String(e) }))
      }

      // Log query + answer (fire and forget — never blocks the response)
      supabase.from('query_log').insert({
        query: logQuery,
        had_results: true,
        source_count: merged.length,
        top_similarity: topSimilarity,
        model: MODEL,
        latency_ms: Date.now() - requestStart,
        answer_preview: answerText.slice(0, 2000),
        input_tokens: usage?.input_tokens ?? null,
        output_tokens: usage?.output_tokens ?? null,
      }).then(() => {})

      controller.enqueue(send({ type: 'done' }))
      controller.close()
    },
  })

  return new Response(readableStream, {
    headers: { 'Content-Type': 'application/x-ndjson' },
  })
}
