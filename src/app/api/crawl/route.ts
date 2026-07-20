import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

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

function isAuthorized(req: NextRequest): boolean {
  if (req.headers.get('x-vercel-cron') === '1') return true
  return req.headers.get('authorization') === `Bearer ${process.env.CRAWL_SECRET}`
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return runCrawl()
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return runCrawl()
}

async function runCrawl() {
  const { default: FirecrawlApp } = await import('@mendable/firecrawl-js')
  const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY })
  const supabase = getSupabaseAdmin()
  const targetUrl = process.env.CRAWL_TARGET_URL ?? 'https://www.tcatitans.org'

  // Start async crawl job
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const job = await (firecrawl.asyncCrawlUrl as any)(targetUrl, {
    limit: 300,
    scrapeOptions: { formats: ['markdown'] },
  })

  if (!job?.id) {
    return NextResponse.json({ error: 'Failed to start crawl job', job }, { status: 500 })
  }

  // Poll for completion (max 4 min)
  const jobId = job.id
  let pages: any[] = []
  const deadline = Date.now() + 4 * 60 * 1000

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 8000))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = await (firecrawl.checkCrawlStatus as any)(jobId)
    if (status?.status === 'completed') {
      pages = status.data ?? []
      break
    }
    if (status?.status === 'failed') {
      return NextResponse.json({ error: 'Crawl job failed', status }, { status: 500 })
    }
  }

  if (!pages.length) {
    return NextResponse.json({ error: 'No pages returned or crawl timed out', jobId }, { status: 500 })
  }

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
