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

  const embeddingRes = await voyage.embed({ input: [query.slice(0, 16000)], model: 'voyage-3-lite' })
  const queryEmbedding = embeddingRes.data![0].embedding!

  const { data: chunks, error } = await supabase.rpc('match_chunks', {
    query_embedding: queryEmbedding,
    match_count: 16,
  })

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const encoder = new TextEncoder()

  const send = (obj: unknown) => encoder.encode(JSON.stringify(obj) + '\n')

  if (!chunks?.length) {
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

  const context = chunks
    .map((c: { title: string; url: string; content: string }, i: number) =>
      `[Source ${i + 1}: ${c.title} (${c.url})]\n${c.content}`
    )
    .join('\n\n---\n\n')

  // Sources (filtered by similarity)
  const answerIsUnknown = false
  const seen = new Set<string>()
  const sources = chunks
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

TCA campuses: Central Elementary, East Elementary, and North Elementary (K–6); one Junior High (grades 7–8); one High School (grades 9–12); plus College Pathways. There is only one JH and one HS — so questions about 7th/8th graders are automatically JH, 9th–12th are automatically HS. Elementary questions may need campus clarification (Central, East, or North).

High school grade levels: 9th = Freshman, 10th = Sophomore, 11th = Junior, 12th = Senior. Understand and use these terms naturally — if a parent says "my freshman" treat it as 9th grade/High School, "my sophomore" as 10th grade/High School, etc.

Be smart about context: sports (football, basketball, soccer, wrestling, cheer, etc.), athletics schedules, and team-specific questions only apply to Junior High and High School — never mention elementary in those answers unless the parent specifically brings it up. If the parent has a 5th grader and asks about football, answer for JH/HS and don't add a note about the elementary student.

Today is ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}. Current school year is 2026-27 — prioritize that data; if you only have 2025-26 info that's likely the same, mention it briefly.

Answer style:
- Lead with the answer. No preamble ("Based on...", "According to...").
- 1–4 sentences for most things. Bullet points only for 3+ distinct items.
- Talk to the parent directly using "your" — "Your 9th grader's first day is...", not "9th graders start on..."
- If you need to clarify campus or grade, ask one short question — don't dump all the options.
- If something's not in the context, say so in one sentence and link them somewhere useful.
- Always include a direct URL as a markdown link when referencing a specific page or form.
- For staff contacts: if not in context, point them to the [staff directory](https://www.tcatitans.org/about/staff-directory).
- For lists (spelling words, supply lists, etc.): reproduce them completely, don't summarize.
- You're in a conversation — use prior context naturally.`

  // Log query (fire and forget)
  const logQuery = (rawQuery ?? query).trim().slice(0, 500)
  supabase.from('query_log').insert({ query: logQuery }).then(() => {})

  // Stream the response
  const readableStream = new ReadableStream({
    async start(controller) {
      // Send sources immediately so UI can show them while text streams
      controller.enqueue(send({ type: 'sources', sources }))

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
