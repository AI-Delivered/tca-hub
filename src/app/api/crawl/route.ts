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
  // Vercel cron sends this header automatically
  if (req.headers.get('x-vercel-cron') === '1') return true
  // Manual trigger requires Bearer secret
  return req.headers.get('authorization') === `Bearer ${process.env.CRAWL_SECRET}`
}

// GET handler for Vercel cron
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return runCrawl()
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return runCrawl()
}

async function runCrawl() {
  const { default: FirecrawlApp } = await import('@mendable/firecrawl-js')
  const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY })
  const supabase = getSupabaseAdmin()
  const targetUrl = process.env.CRAWL_TARGET_URL ?? 'https://www.tcatitans.org'

  let indexed = 0
  let errors = 0

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const crawlResult = await (firecrawl.crawlUrl as any)(targetUrl, {
    limit: 300,
    scrapeOptions: { formats: ['markdown'] },
  })

  const pages = Array.isArray(crawlResult) ? crawlResult
    : crawlResult?.data ?? []

  if (!pages.length) {
    return NextResponse.json({ error: 'Crawl returned no pages' }, { status: 500 })
  }

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

  return NextResponse.json({ indexed, errors, pages: pages.length })
}
