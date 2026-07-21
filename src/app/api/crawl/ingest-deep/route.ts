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

function extractTcaUrls(text: string): string[] {
  const found = new Set<string>()
  const patterns = [
    // Markdown links and plain URLs
    /https?:\/\/www\.tcatitans\.org\/[^\s\)\]"'<>]+/g,
    // Relative /fs/pages/ and /fs/resource-manager/ paths
    /(?:href=["'])(\/fs\/(?:pages|resource-manager\/view)\/[^"']+)/g,
  ]
  for (const re of patterns) {
    const matches = text.matchAll(re)
    for (const m of matches) {
      let url = m[1] ?? m[0]
      // Make relative paths absolute
      if (url.startsWith('/')) url = `https://www.tcatitans.org${url}`
      // Strip anchors and trailing punctuation
      url = url.replace(/#.*$/, '').replace(/[.,;)]+$/, '').trim()
      if (url.startsWith('https://www.tcatitans.org')) found.add(url)
    }
  }
  return [...found]
}

// Skip URLs that are navigation/shell pages unlikely to have useful content
function isLikelyUseful(url: string): boolean {
  const skip = [
    '/giving/', '/alumni', '/titan-club', '/tca-moments-blog',
    '/explore-tca/tca-titan-of-the-year', '/sitemap', '/login',
    '/logout', '/search', '?const_page=', 'javascript:',
  ]
  return !skip.some(s => url.includes(s))
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { VoyageAIClient } = await import('voyageai')
  const { default: FirecrawlApp } = await import('@mendable/firecrawl-js')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY })
  const supabase = getSupabaseAdmin()

  // 1. Get all URLs already indexed (just URLs, not full content)
  const { data: urlRows } = await supabase
    .from('page_chunks')
    .select('url')

  const indexedUrls = new Set((urlRows ?? []).map(r => r.url))

  // 2. Extract TCA URLs from a sample of content (avoid pulling all 1200+ chunks)
  const { data: contentRows } = await supabase
    .from('page_chunks')
    .select('content')
    .limit(300)

  const referencedUrls = new Set<string>()
  for (const row of contentRows ?? []) {
    for (const url of extractTcaUrls(row.content)) {
      referencedUrls.add(url)
    }
  }

  // 3. Find the gap: referenced but not indexed, and likely useful
  const toScrape = [...referencedUrls].filter(
    url => !indexedUrls.has(url) && isLikelyUseful(url)
  )

  // Also add known high-value pages that may have been missed
  const mustHave = [
    'https://www.tcatitans.org/fs/pages/806', // Central Elementary hours
    'https://www.tcatitans.org/fs/pages/807', // East Elementary hours
    'https://www.tcatitans.org/fs/pages/808', // North Elementary hours (guess)
    'https://www.tcatitans.org/fs/pages/809',
    'https://www.tcatitans.org/fs/pages/810',
    'https://www.tcatitans.org/fs/pages/811', // Summer reading
    'https://www.tcatitans.org/fs/pages/812', // Supply lists
    'https://www.tcatitans.org/fs/pages/813', // State assessments
    'https://www.tcatitans.org/family/school-hoursbell-schedule',
    'https://www.tcatitans.org/family/dress-code',
    'https://www.tcatitans.org/family/student-handbook',
    'https://www.tcatitans.org/family/lunch-information',
    'https://www.tcatitans.org/family/attendance-absences',
    'https://www.tcatitans.org/schools/high-school/bell-schedule',
    'https://www.tcatitans.org/schools/junior-high/bell-schedule',
  ]
  for (const url of mustHave) {
    if (!indexedUrls.has(url)) toScrape.push(url)
  }

  // Dedupe
  const queue = [...new Set(toScrape)].slice(0, 80) // cap at 80 per run

  let indexed = 0, skipped = 0, errors = 0
  const newUrls: string[] = []

  for (const url of queue) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (firecrawl.scrapeUrl as any)(url, {
        formats: ['markdown'],
        parsePDF: true,
      })

      const content: string = result?.markdown ?? ''
      const title: string = result?.metadata?.title ?? result?.metadata?.ogTitle ?? url

      // Skip low-quality pages (mostly nav, no real content)
      const stripped = content.replace(/\[.*?\]\(.*?\)/g, '').replace(/#+\s/g, '').trim()
      if (stripped.length < 150) { skipped++; continue }

      // Delete old chunks for this URL and re-index
      await supabase.from('page_chunks').delete().eq('url', url)

      const chunks = chunkText(content)
      const embeddingRes = await voyage.embed({
        input: chunks.map(c => c.slice(0, 16000)),
        model: 'voyage-3-lite',
      })

      for (let i = 0; i < chunks.length; i++) {
        const embedding = embeddingRes.data?.[i]?.embedding
        if (!embedding) continue
        const { error } = await supabase.from('page_chunks').insert({
          url, title, content: chunks[i], embedding,
        })
        if (error) errors++; else indexed++
      }
      newUrls.push(url)

      // Extract new URLs from this page's content and add to next run candidates
      // (they'll be picked up automatically next time this runs)

    } catch {
      errors++
    }
  }

  return NextResponse.json({
    queued: queue.length,
    indexed,
    skipped,
    errors,
    newPages: newUrls.length,
    sample: newUrls.slice(0, 10),
  })
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return POST(req)
}
