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
    system: `You are a helpful assistant for The Classical Academy (TCA) school in Colorado Springs.
Answer questions using the provided context from the TCA website. Be specific and direct — give actual times, names, dates, and details from the context.
When the context contains the answer, state it clearly and completely. Do not hedge or say you don't have information if the answer is present.
If multiple schools have different schedules, list each one.
Only suggest visiting tcatitans.org if the information is genuinely absent from the context.`,
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
