import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isCrawlAuthorized } from '@/lib/auth'
import { pageBody } from '@/lib/page-body'
import { withIngestLog } from '@/lib/ingest-log'

export const maxDuration = 300

function chunkText(text: string, chunkSize = 1800, overlap = 200): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    chunks.push(text.slice(start, start + chunkSize))
    start += chunkSize - overlap
  }
  return chunks
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|td|th)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ').replace(/&[a-z]+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim()
}

// Pages with graphical/image-based content requiring vision extraction
const VISUAL_PAGES = [
  { url: 'https://www.tcatitans.org/fs/pages/808', title: 'TCA High School Bell Schedule' },
  { url: 'https://www.tcatitans.org/fs/pages/809', title: 'TCA Junior High Bell Schedule' },
  { url: 'https://www.tcatitans.org/fs/resource-manager/view/a1ba13ea-030c-46dc-85be-117220e1dcc9', title: 'TCA School Calendar 2026-27 (All Schools)', isPdf: true },
  { url: 'https://www.tcatitans.org/fs/resource-manager/view/2aff1014-76a4-4f17-9ed2-d616c57aa3cf', title: 'TCA School Calendar 2026-27 (Elementary)', isPdf: true },
  { url: 'https://www.tcatitans.org/fs/resource-manager/view/d50acc49-99ee-4cfa-9658-1a2da93b8796', title: 'TCA School Calendar 2026-27 (Secondary)', isPdf: true },
]

// Matches the crawler's floor, so the two routes agree on what an empty page is.
const CONTENT_FLOOR = 150

type AnthropicClient = InstanceType<typeof import('@anthropic-ai/sdk').default>

async function extractPage(
  page: { url: string; title: string; isPdf?: boolean },
  anthropic: AnthropicClient
): Promise<string> {
  const res = await fetch(page.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TCAHub/1.0)' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  if (page.isPdf) {
    const buffer = await res.arrayBuffer()
    const base64 = Buffer.from(buffer).toString('base64')
    /* 3,000 was enough for today's three calendars — measured, they extract in
     * about 1,200 output tokens and stop on end_turn — but there was no check
     * that it had been enough, and that is the part that matters. ingest-pdfs
     * had the same shape and it did bite there: a 30-page handbook came back as
     * its table of contents and looked exactly like a short document. If one of
     * these documents grows, this now says so instead of storing half of it.
     */
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 16_000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: `Extract ALL content from this "${page.title}" document. Include every date, event, holiday, break, period, and note. Output as structured plain text so parents can find schedule info easily.` },
        ],
      }],
    })
    if (msg.stop_reason === 'max_tokens') {
      throw new Error(`extraction hit the token ceiling — "${page.title}" is incomplete, not storing`)
    }
    return msg.content[0].type === 'text' ? msg.content[0].text ?? '' : ''
  }

  // HTML page — try text extraction first. Chrome off before measuring it, or
  // every page clears any floor on site furniture alone. See lib/page-body.
  const html = await res.text()
  const text = pageBody(htmlToText(html))

  // If content is thin (mostly nav/boilerplate), use vision on any images found
  if (text.replace(/\s/g, '').length < 400) {
    const imgMatches = [...html.matchAll(/src=["']([^"']*\.(jpg|jpeg|png|gif|webp))[^"']*["']/gi)]
    for (const m of imgMatches) {
      let imgUrl = m[1]
      if (imgUrl.startsWith('/')) imgUrl = 'https://www.tcatitans.org' + imgUrl
      if (!imgUrl.startsWith('http')) continue
      try {
        const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(10000) })
        if (!imgRes.ok) continue
        const imgBuffer = await imgRes.arrayBuffer()
        const base64 = Buffer.from(imgBuffer).toString('base64')
        const mediaType = (imgRes.headers.get('content-type') || 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
        const msg = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2048,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
              { type: 'text', text: `This is "${page.title}" from TCA school. Extract ALL visible text including every period, time, class name, date, and note. Output as structured plain text.` },
            ],
          }],
        })
        if (msg.content[0].type === 'text' && msg.content[0].text && msg.content[0].text.length > 200) {
          return msg.content[0].text
        }
      } catch { continue }
    }
  }

  return text
}

async function run(req: NextRequest) {
  if (!isCrawlAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { VoyageAIClient } = await import('voyageai')
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  /* Typed, not `as any`. The cast un-typed every call on this client, which is
   * how this route kept a 3,000-token ceiling and no stop_reason check while
   * ingest-pdfs grew both — nothing could tell them apart.
   */
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()

  const results: { title: string; chars: number; chunks: number }[] = []
  const errors: string[] = []

  for (const page of VISUAL_PAGES) {
    try {
      const content = await extractPage(page, anthropic)

      /* A page with nothing of its own is not stored, and anything previously
       * stored for it is removed.
       *
       * The two bell-schedule entries here are HTML shells wrapped around a
       * linked PDF — 322 and 330 characters, all of it navigation. This route
       * stored them under the titles "TCA High School Bell Schedule" and "TCA
       * Junior High Bell Schedule", which are close to word-for-word the
       * question a parent asks, and the High School one was the top vector hit
       * for "what time does the high school day end" while containing no times.
       * The crawler had already been taught not to do this; this route had not,
       * and wrote them straight back under a better title than the crawler ever
       * gave them.
       */
      if (!content || content.trim().length < CONTENT_FLOOR) {
        await supabase.from('page_chunks').delete().eq('url', page.url)
        errors.push(`${page.title}: no content of its own (${content.trim().length} chars)`)
        continue
      }

      await supabase.from('page_chunks').delete().eq('url', page.url)
      const chunks = chunkText(content)
      const embRes = await voyage.embed({
        input: chunks.map(c => c.slice(0, 16000)),
        model: 'voyage-3-lite',
      })

      let inserted = 0
      for (let i = 0; i < chunks.length; i++) {
        const embedding = embRes.data?.[i]?.embedding
        if (!embedding) continue
        const { error } = await supabase.from('page_chunks').insert({
          url: page.url, title: page.title, content: chunks[i], embedding, crawled_at: now,
        })
        if (!error) inserted++
      }
      results.push({ title: page.title, chars: content.length, chunks: inserted })
    } catch (e) {
      errors.push(`${page.title}: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`)
    }
  }

  return NextResponse.json({ results, errors })
}

export async function GET(req: NextRequest) {
  if (!isCrawlAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return handler(req)
}

/** Every invocation is recorded so the dashboard can report what changed. */
function handler(req: NextRequest) {
  return withIngestLog(req, '/api/crawl/ingest-visual', () => run(req))
}

export const POST = handler
