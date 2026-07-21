import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  const { query } = await req.json()
  if (!query?.trim()) {
    return NextResponse.json({ error: 'Query required' }, { status: 400 })
  }

  const [{ VoyageAIClient }, { default: Anthropic }] = await Promise.all([
    import('voyageai'),
    import('@anthropic-ai/sdk'),
  ])

  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const supabase = getSupabaseAdmin()

  // Embed the query
  const embeddingRes = await voyage.embed({ input: [query.slice(0, 16000)], model: 'voyage-3-lite' })
  const queryEmbedding = embeddingRes.data![0].embedding!

  // Find the most relevant chunks
  const { data: chunks, error } = await supabase.rpc('match_chunks', {
    query_embedding: queryEmbedding,
    match_count: 12,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!chunks?.length) {
    return NextResponse.json({
      answer: "I couldn't find information about that on the TCA website. Try rephrasing your question or visit tcatitans.org directly.",
      sources: [],
    })
  }

  const context = chunks
    .map((c: { title: string; url: string; content: string }, i: number) =>
      `[Source ${i + 1}: ${c.title} (${c.url})]\n${c.content}`
    )
    .join('\n\n---\n\n')

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    system: `You are a concise assistant for The Classical Academy (TCA) in Colorado Springs. TCA has multiple campuses: Central Elementary, East Elementary, North Elementary, Junior High, High School, and College Pathways.
Answer in 1-4 sentences max. Be direct — lead with the answer, not context-setting.
Use bullet points only when listing 3+ distinct items. No preamble like "Based on the context..." or "According to the TCA website...".
If the question is about schedules, supply lists, spelling lists, or other grade/campus-specific info and the context has multiple different answers, ask one short clarifying question like "Which campus or grade?" before answering — don't list everything.
If the context has clear info for all campuses, summarize briefly by campus.
If the info isn't in the context, say so in one sentence.
For staff email or contact requests: if the info isn't in the context, say you couldn't find it and direct them to the staff directory at https://www.tcatitans.org/about/staff-directory.`,
    messages: [
      {
        role: 'user',
        content: `Context from TCA website:\n\n${context}\n\nQuestion: ${query}`,
      },
    ],
  })

  const answer = message.content[0].type === 'text' ? message.content[0].text : ''

  // Only show sources that are actually relevant (similarity > 0.35), max 4
  const seen = new Set<string>()
  const sources = chunks
    .filter((c: { url: string; similarity: number }) => {
      if (c.similarity < 0.35) return false
      if (seen.has(c.url)) return false
      seen.add(c.url)
      return true
    })
    .slice(0, 4)
    .map((c: { url: string; title: string }) => ({ url: c.url, title: c.title }))

  return NextResponse.json({ answer, sources })
}
