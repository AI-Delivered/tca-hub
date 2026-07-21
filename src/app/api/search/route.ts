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
    system: `You are a concise assistant for The Classical Academy (TCA) in Colorado Springs.
Answer in 1-4 sentences max. Be direct — lead with the answer, not context-setting.
Use bullet points only when listing 3+ distinct items. No preamble like "Based on the context..." or "According to the TCA website...".
If multiple schools differ, list each briefly. If the info isn't in the context, say so in one sentence.`,
    messages: [
      {
        role: 'user',
        content: `Context from TCA website:\n\n${context}\n\nQuestion: ${query}`,
      },
    ],
  })

  const answer = message.content[0].type === 'text' ? message.content[0].text : ''

  const seen = new Set<string>()
  const sources = chunks
    .filter((c: { url: string }) => {
      if (seen.has(c.url)) return false
      seen.add(c.url)
      return true
    })
    .map((c: { url: string; title: string }) => ({ url: c.url, title: c.title }))

  return NextResponse.json({ answer, sources })
}
