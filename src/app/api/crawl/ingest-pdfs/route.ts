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

// Finds all /fs/resource-manager/view/ links from indexed pages and scrapes them as PDFs
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { VoyageAIClient } = await import('voyageai')
  const { default: FirecrawlApp } = await import('@mendable/firecrawl-js')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY })
  const supabase = getSupabaseAdmin()

  // Pull all resource-manager URLs referenced in indexed content
  const { data: rows } = await supabase
    .from('page_chunks')
    .select('content')
    .ilike('content', '%resource-manager/view/%')

  const urlSet = new Set<string>()
  for (const row of rows ?? []) {
    const matches = row.content.match(/https:\/\/www\.tcatitans\.org\/fs\/resource-manager\/view\/[a-f0-9-]+/g) ?? []
    matches.forEach((u: string) => urlSet.add(u))
  }

  // Get already-indexed URLs to skip them (fetch all pages)
  const indexed_urls = new Set<string>()
  let page = 0
  while (true) {
    const { data: batch } = await supabase.from('page_chunks').select('url').range(page * 1000, (page + 1) * 1000 - 1)
    if (!batch?.length) break
    batch.forEach(r => indexed_urls.add(r.url))
    if (batch.length < 1000) break
    page++
  }

  // Only process unindexed URLs, cap at 30 per run
  const urls = [...urlSet].filter(u => !indexed_urls.has(u)).slice(0, 30)
  let indexed = 0, skipped = 0, errors = 0

  for (const url of urls) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (firecrawl.scrapeUrl as any)(url, {
        formats: ['markdown'],
      })
      const content = result?.markdown ?? ''
      const title = result?.metadata?.title ?? url

      if (!content.trim() || content.length < 100) { skipped++; continue }

      await supabase.from('page_chunks').delete().eq('url', url)
      const chunks = chunkText(content)
      const embeddingRes = await voyage.embed({
        input: chunks.map(c => c.slice(0, 16000)),
        model: 'voyage-3-lite',
      })

      for (let i = 0; i < chunks.length; i++) {
        const embedding = embeddingRes.data?.[i]?.embedding
        if (!embedding) continue
        const { error } = await supabase.from('page_chunks').insert({ url, title, content: chunks[i], embedding })
        if (error) errors++; else indexed++
      }
      await new Promise(r => setTimeout(r, 200))
    } catch {
      errors++
    }
  }

  return NextResponse.json({ indexed, skipped, errors, total: urls.length })
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return POST(req)
}
