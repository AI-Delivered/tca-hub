import { NextRequest, NextResponse } from 'next/server'
import FirecrawlApp from '@mendable/firecrawl-js'
import OpenAI from 'openai'
import { getSupabaseAdmin } from '@/lib/supabase'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

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
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 8000),
  })
  return res.data[0].embedding
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
  const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY })
  const supabase = getSupabaseAdmin()
  const targetUrl = process.env.CRAWL_TARGET_URL ?? 'https://www.tcatitans.org'

  let indexed = 0
  let errors = 0

  const crawlResult = await firecrawl.crawlUrl(targetUrl, {
    limit: 300,
    scrapeOptions: { formats: ['markdown'] },
  })

  if (!crawlResult.success || !crawlResult.data) {
    return NextResponse.json({ error: 'Crawl failed' }, { status: 500 })
  }

  for (const page of crawlResult.data) {
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

  return NextResponse.json({ indexed, errors, pages: crawlResult.data.length })
}
