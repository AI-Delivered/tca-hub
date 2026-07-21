import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export const maxDuration = 300 // 5 min (requires Vercel Pro)

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

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { jobId, offset = 0, batchSize = 20 } = await req.json()
  if (!jobId) return NextResponse.json({ error: 'jobId required' }, { status: 400 })

  const { default: FirecrawlApp } = await import('@mendable/firecrawl-js')
  const { VoyageAIClient } = await import('voyageai')
  const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY })
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
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

  const allPages = status.data ?? []
  const pages = allPages.slice(offset, offset + batchSize)
  let indexed = 0
  let errors = 0

  for (const page of pages) {
    const url = page.metadata?.sourceURL ?? ''
    const title = page.metadata?.title ?? ''
    const content = page.markdown ?? ''

    if (!content.trim() || !url) continue

    const chunks = chunkText(content)

    // Batch embed all chunks for this page at once
    try {
      await supabase.from('page_chunks').delete().eq('url', url)

      const inputs = chunks.map(c => c.slice(0, 16000))
      const embeddingRes = await voyage.embed({ input: inputs, model: 'voyage-3-lite' })

      for (let i = 0; i < chunks.length; i++) {
        const embedding = embeddingRes.data?.[i]?.embedding
        if (!embedding) continue
        const { error } = await supabase.from('page_chunks').insert({ url, title, content: chunks[i], embedding })
        if (error) errors++
        else indexed++
      }
    } catch {
      errors++
    }
  }

  const nextOffset = offset + batchSize
  const hasMore = nextOffset < allPages.length

  return NextResponse.json({
    indexed,
    errors,
    processed: pages.length,
    total: allPages.length,
    offset,
    nextOffset: hasMore ? nextOffset : null,
    done: !hasMore,
  })
}
