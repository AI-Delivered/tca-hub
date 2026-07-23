import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export const maxDuration = 300

function isAuthorized(req: NextRequest): boolean {
  if (req.headers.get('x-vercel-cron') === '1') return true
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret === process.env.CRAWL_SECRET) return true
  return req.headers.get('authorization') === `Bearer ${process.env.CRAWL_SECRET}`
}

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function extractPage(page: { url: string; title: string; isPdf?: boolean }, anthropic: any): Promise<string> {
  const res = await fetch(page.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TCAHub/1.0)' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  if (page.isPdf) {
    const buffer = await res.arrayBuffer()
    const base64 = Buffer.from(buffer).toString('base64')
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: `Extract ALL content from this "${page.title}" document. Include every date, event, holiday, break, period, and note. Output as structured plain text so parents can find schedule info easily.` },
        ],
      }],
    })
    return msg.content[0].type === 'text' ? msg.content[0].text ?? '' : ''
  }

  // HTML page — try text extraction first
  const html = await res.text()
  const text = htmlToText(html)

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

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { VoyageAIClient } = await import('voyageai')
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) as any
  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()

  const results: { title: string; chars: number; chunks: number }[] = []
  const errors: string[] = []

  for (const page of VISUAL_PAGES) {
    try {
      const content = await extractPage(page, anthropic)
      if (!content || content.trim().length < 50) {
        errors.push(`${page.title}: no content`)
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
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return POST(req)
}
