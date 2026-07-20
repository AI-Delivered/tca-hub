import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { getSupabaseAdmin } from '@/lib/supabase'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(req: NextRequest) {
  const { query } = await req.json()
  if (!query?.trim()) {
    return NextResponse.json({ error: 'Query required' }, { status: 400 })
  }

  const supabase = getSupabaseAdmin()

  // Embed the query
  const embeddingRes = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: query.slice(0, 8000),
  })
  const queryEmbedding = embeddingRes.data[0].embedding

  // Find the most relevant chunks
  const { data: chunks, error } = await supabase.rpc('match_chunks', {
    query_embedding: queryEmbedding,
    match_count: 6,
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

  // Build context from matched chunks
  const context = chunks
    .map((c: { title: string; url: string; content: string }, i: number) =>
      `[Source ${i + 1}: ${c.title} (${c.url})]\n${c.content}`
    )
    .join('\n\n---\n\n')

  // Ask Claude to synthesize an answer
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 512,
    system: `You are a helpful assistant for The Classical Academy (TCA) school in Colorado Springs.
Answer questions using only the provided context from the TCA website.
Be concise and direct. Always cite which source your answer comes from.
If the context doesn't contain enough information, say so and suggest the user visit tcatitans.org.`,
    messages: [
      {
        role: 'user',
        content: `Context from TCA website:\n\n${context}\n\nQuestion: ${query}`,
      },
    ],
  })

  const answer = message.content[0].type === 'text' ? message.content[0].text : ''

  // Deduplicate sources
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
