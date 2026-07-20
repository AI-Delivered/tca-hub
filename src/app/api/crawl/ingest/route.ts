import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

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

async function embedText(text: string): Promise<number[]> {
  const { VoyageAIClient } = await import('voyageai')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const res = await voyage.embed({ input: [text.slice(0, 16000)], model: 'voyage-3-lite' })
  return res.data![0].embedding!
}

// Fetches a completed Firecrawl job and indexes all pages into Supabase.
// Call this ~5 minutes after POST /api/crawl with the returned jobId.
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { jobId } = await req.json()
  if (!jobId) return NextResponse.json({ error: 'jobId required' }, { status: 400 })

  const { default: FirecrawlApp } = await import('@mendable/firecrawl-js')
  const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY })
  const supabase = getSupabaseAdmin()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const status = await (firecrawl.checkCrawlStatus as any)(jobId)

  if (status?.status !== 'completed') {
    return NextResponse.json({
      error: 'Crawl not complete yet',
      status: status?.status,
      progress: status?.completed,
      total: status?.total,
    }, { status: 202 })
  }

  const pages = status.data ?? []
  let indexed = 0
  let errors = 0

  for (const page of pages) {
    const url = page.metadata?.sourceURL ?? ''
    const title = page.metadata?.title ?? ''
    const content = page.markdown ?? ''

    if (!content.trim() || !url) continue

    await supabase.from('page_chunks').delete().eq('url', url)

    for (const chunk of chunkText(content)) {
      try {
        const embedding = await embedText(chunk)
        await supabase.from('page_chunks').insert({ url, title, content: chunk, embedding })
        indexed++
      } catch {
        errors++
      }
    }
  }

  return NextResponse.json({ indexed, errors, pages: pages.length, jobId })
}
