import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export const maxDuration = 300

function isAuthorized(req: NextRequest): boolean {
  if (req.headers.get('x-vercel-cron') === '1') return true
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

// Pages known to contain graphical/image-based content that needs vision extraction
const VISUAL_PAGES = [
  { url: 'https://www.tcatitans.org/fs/pages/808', title: 'TCA High School Bell Schedule' },
  { url: 'https://www.tcatitans.org/fs/pages/809', title: 'TCA Junior High Bell Schedule' },
  // Calendar PDFs are graphical — re-extract with vision
  { url: 'https://www.tcatitans.org/fs/resource-manager/view/a1ba13ea-030c-46dc-85be-117220e1dcc9', title: 'TCA School Calendar 2026-27 (All Schools)' },
  { url: 'https://www.tcatitans.org/fs/resource-manager/view/2aff1014-76a4-4f17-9ed2-d616c57aa3cf', title: 'TCA School Calendar 2026-27 (Elementary)' },
  { url: 'https://www.tcatitans.org/fs/resource-manager/view/d50acc49-99ee-4cfa-9658-1a2da93b8796', title: 'TCA School Calendar 2026-27 (Secondary)' },
]

async function extractWithVision(screenshotUrl: string, pageTitle: string, anthropic: any): Promise<string> {
  const imgRes = await fetch(screenshotUrl)
  if (!imgRes.ok) throw new Error(`Failed to fetch screenshot: ${imgRes.status}`)
  const imgBuffer = await imgRes.arrayBuffer()
  const base64 = Buffer.from(imgBuffer).toString('base64')
  const mediaType = (imgRes.headers.get('content-type') || 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        {
          type: 'text',
          text: `This is a screenshot of "${pageTitle}" from the TCA (The Classical Academy) school website. Extract ALL information visible in this image as structured plain text. Include every time, date, period name, event, break, holiday, and note you can see. Be thorough and accurate — this text will be used to answer parent questions about the school schedule.`
        }
      ]
    }]
  })

  return msg.content[0].type === 'text' ? msg.content[0].text : ''
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { VoyageAIClient } = await import('voyageai')
  const { default: FirecrawlApp } = await import('@mendable/firecrawl-js')
  const { default: Anthropic } = await import('@anthropic-ai/sdk')

  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY })
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const supabase = getSupabaseAdmin()

  const results: { url: string; title: string; chars: number; chunks: number; method: string }[] = []
  const errors: string[] = []

  for (const page of VISUAL_PAGES) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const scraped = await (firecrawl.scrapeUrl as any)(page.url, {
        formats: ['markdown', 'screenshot'],
      })

      const markdown: string = scraped?.markdown ?? ''
      const screenshotUrl: string = scraped?.screenshot ?? ''

      // Check if markdown has meaningful content (not just nav/legend)
      const strippedMd = markdown.replace(/\[.*?\]\(.*?\)/g, '').replace(/[#\s]/g, '')
      const needsVision = strippedMd.length < 300 && screenshotUrl

      let content = markdown
      let method = 'markdown'

      if (needsVision && screenshotUrl) {
        content = await extractWithVision(screenshotUrl, page.title, anthropic)
        method = 'vision'
      }

      if (!content || content.trim().length < 50) {
        errors.push(`${page.title}: no content extracted`)
        continue
      }

      // Re-index
      await supabase.from('page_chunks').delete().eq('url', page.url)
      const chunks = chunkText(content)
      const embeddingRes = await voyage.embed({
        input: chunks.map(c => c.slice(0, 16000)),
        model: 'voyage-3-lite',
      })

      let indexed = 0
      for (let i = 0; i < chunks.length; i++) {
        const embedding = embeddingRes.data?.[i]?.embedding
        if (!embedding) continue
        const { error } = await supabase.from('page_chunks').insert({
          url: page.url,
          title: page.title,
          content: chunks[i],
          embedding,
        })
        if (!error) indexed++
      }

      results.push({ url: page.url, title: page.title, chars: content.length, chunks: indexed, method })
      await new Promise(r => setTimeout(r, 2200))
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
