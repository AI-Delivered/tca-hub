import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export const maxDuration = 60

export async function POST(req: NextRequest) {
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
  const retrievalQuery = lastUserMsg ? `${lastUserMsg} ${query}` : query
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

  // Calendar keyword fallback: specific event names (literacy testing, picture day, etc.)
  // won't score well in vector search because they appear in one monthly chunk among hundreds.
  const calEventTerms = [
    'literacy testing', 'picture day', 'field trip', 'open house', 'back to school',
    'parent teacher', 'conference', 'curriculum night', 'grandparent', 'fall festival',
    'spring fling', 'book fair', 'spirit week', 'talent show', 'science fair',
    'kindergarten', 'early out', 'early release', 'no school', 'teacher inservice',
    'first day', 'last day', 'winter break', 'spring break', 'fall break', 'thanksgiving',
    'christmas', 'halloween', 'valentines', 'auction', 'carnival',
  ]
  const calTermMatch = calEventTerms.find(t => query.toLowerCase().includes(t))
  if (calTermMatch) {
    // Determine campus filter from query if mentioned
    const campusMap: Record<string, string> = {
      'east': 'east-elementary-calendar',
      'central': 'central-elementary-calendar',
      'north': 'north-elementary-calendar',
      'junior high': 'junior-high-calendar',
      'jh': 'junior-high-calendar',
      'high school': 'high-school-calendar',
      'college pathways': 'college-pathways-calendar',
      'cp': 'college-pathways-calendar',
    }
    const campusKey = Object.keys(campusMap).find(k => query.toLowerCase().includes(k))
    const urlFilter = campusKey ? `%${campusMap[campusKey]}%` : '%-calendar%'
    const { data: calRows } = await supabase
      .from('page_chunks')
      .select('url, title, content')
      .ilike('url', urlFilter)
      .ilike('content', `%${calTermMatch}%`)
      .order('url', { ascending: true })
      .limit(20)
    const calChunks = (calRows ?? []).map(c => ({ ...c, similarity: 0.65 }))
    keywordChunks = [...keywordChunks, ...calChunks]
  }

  // Merge: vector results first, then any keyword-only hits not already included
  const seenUrls = new Set((chunks ?? []).map((c: Chunk) => c.url))
  const merged: Chunk[] = [
    ...(chunks ?? []),
    ...keywordChunks.filter(c => !seenUrls.has(c.url)),
  ]

  const encoder = new TextEncoder()

  const send = (obj: unknown) => encoder.encode(JSON.stringify(obj) + '\n')

  if (!merged?.length) {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(send({ type: 'sources', sources: [] }))
        controller.enqueue(send({ type: 'text', text: "I couldn't find information about that on the TCA website. Try rephrasing your question or visit tcatitans.org directly." }))
        controller.enqueue(send({ type: 'done' }))
        controller.close()
      }
    })
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } })
  }

  // Extract a staff card if the query is about a specific person.
  // Collect ALL matching person lines across all chunks, then only show the card
  // when there's exactly one unique person match (avoid showing the wrong Pollard, etc.)
  let staffCard: { name: string; role: string; email: string; photo: string; campus: string } | null = null
  const personName = nameMatch?.[1]?.trim() ?? null
  if (personName) {
    type CardCandidate = { name: string; role: string; email: string; photo: string; campus: string }
    const candidates: CardCandidate[] = []
    const seenNames = new Set<string>()
    for (const chunk of merged) {
      const titleLine = chunk.content.split('\n')[0] ?? ''
      const campusName = titleLine.split(' — ')[0].trim()
      for (const line of chunk.content.split('\n')) {
        const photoMatch = line.match(/\[photo:([^\]]+)\]/)
        const stripped = line.replace(/\s*\[photo:[^\]]+\]/g, '').trim()
        const lineMatch = stripped.match(/^(.+?):\s+(.+?)\s+—\s+([\w.]+@tcatitans\.org)$/)
        if (lineMatch && stripped.toLowerCase().includes(personName.toLowerCase())) {
          const fullName = lineMatch[2].trim()
          if (!seenNames.has(fullName)) {
            seenNames.add(fullName)
            candidates.push({ name: fullName, role: lineMatch[1].trim(), email: lineMatch[3].trim(), photo: photoMatch?.[1] ?? '', campus: campusName })
          }
        }
      }
    }
    // Only show a card when exactly one person matched — multiple matches means ambiguous
    if (candidates.length === 1) staffCard = candidates[0]
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

  const systemPrompt = `You are a helpful assistant for TCA (The Classical Academy) in Colorado Springs, talking directly with a TCA parent. Be warm and conversational — you're a knowledgeable friend who knows TCA inside and out, not a help desk writing a report.

HARD RULE: Do not ask follow-up questions. Ever. Do not end with "Is there anything else I can help you with?", "Is that who you're looking for?", "Does that help?", or any question. Answer, then stop.

TCA campuses: Central Elementary, East Elementary, and North Elementary (K–6); one Junior High (grades 7–8); one High School (grades 9–12); plus College Pathways. There is only one JH and one HS — so questions about 7th/8th graders are automatically JH, 9th–12th are automatically HS. Elementary questions may need campus clarification (Central, East, or North).

Synonyms — treat all of these as identical: "Junior High" = "JH" = "middle school" = "7th grade" = "8th grade" = "seventh grade" = "eighth grade" = "grades 7-8". If a parent says "middle school" or "my 7th grader," that means Junior High. Carry campus/school context between turns: if the prior question was about Junior High, assume the next question is also about Junior High unless stated otherwise.

High school grade levels: 9th = Freshman, 10th = Sophomore, 11th = Junior, 12th = Senior. Understand and use these terms naturally — if a parent says "my freshman" treat it as 9th grade/High School, "my sophomore" as 10th grade/High School, etc.

Be smart about context: sports (football, basketball, soccer, wrestling, cheer, etc.), athletics schedules, and team-specific questions only apply to Junior High and High School — never mention elementary in those answers unless the parent specifically brings it up. Literacy testing (DIBELS, reading assessments, oral reading fluency, etc.) only applies to elementary campuses (Central, East, North) — never reference it for Junior High or High School. If the parent has a 5th grader and asks about football, answer for JH/HS and don't add a note about the elementary student.

Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Denver' })}. Current school year is 2026-27. For calendar events: only cite dates that are in the future (after today). If you only have a past date for a recurring annual event, say "Last year it was [date] — the 2026-27 date hasn't been posted yet" rather than citing the past date as the answer. Never present a date that has already passed as if it answers "when is X."

Sports schedule accuracy rule: The schedule data in context is exhaustive and level-specific. Events are tagged [Team Level (Sex)] — e.g., [Football Varsity (Boys)], [Football C-Squad (Boys)], [Football JH A (Boys)]. These tags are the authoritative source of truth. Rules:
1. When asked about a specific level, ONLY list dates/times from events tagged with that EXACT level. If an event isn't tagged for that level, it does not apply — period.
2. [Football C-Squad (Boys)] events are C-Squad only. They are not Varsity. Never include them in a Varsity answer.
3. If no upcoming events for a requested level appear in context, say practice hasn't been scheduled yet and link to the gobound calendar.
4. Never extrapolate, assume, or pattern-match from other levels or days. Only cite explicit events.

Answer style:
- Lead with the answer. No preamble ("Based on...", "According to...").
- **NEVER end with a question of any kind. The HARD RULE above is absolute — it overrides everything else. When in doubt: answer, then stop.**
- When a question could apply to multiple campuses or grade levels with no prior context, list the answer for each one briefly — do not ask which campus. E.g. "School ends at 3:30 PM at all three elementaries (Mon–Thu), 3:00 PM at JH, and 3:10 PM at HS." Asking is never the right move.
- 1–4 sentences for most things. Bullet points only for 3+ distinct items.
- Talk to the parent directly using "your" — "Your 9th grader's first day is...", not "9th graders start on..."
- If something's not in the context, say so in one sentence and link them somewhere useful (the staff directory, the TCA website, or a relevant campus page).
- Always include a direct URL as a markdown link when referencing a specific page or form.
- For staff contacts: if not in context, point them to the [staff directory](https://www.tcatitans.org/family/staff-directory).
- For lists (spelling words, supply lists, etc.): reproduce them completely, don't summarize.
- You're in a conversation — use prior context naturally. **Conversation context beats profile**: if the prior turn mentioned a specific campus or school, assume that campus for follow-up questions without clarifying.`

  // Log query (fire and forget)
  const logQuery = (rawQuery ?? query).trim().slice(0, 500)
  supabase.from('query_log').insert({ query: logQuery }).then(() => {})

  // Stream the response
  const readableStream = new ReadableStream({
    async start(controller) {
      controller.enqueue(send({ type: 'sources', sources }))
      if (staffCard) controller.enqueue(send({ type: 'staffCard', staffCard }))

      try {
        const stream = anthropic.messages.stream({
          model: 'claude-haiku-4-5-20251001',
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
            controller.enqueue(send({ type: 'text', text: event.delta.text }))
          }
        }
      } catch (e) {
        controller.enqueue(send({ type: 'error', message: String(e) }))
      }

      controller.enqueue(send({ type: 'done' }))
      controller.close()
    },
  })

  return new Response(readableStream, {
    headers: { 'Content-Type': 'application/x-ndjson' },
  })
}
