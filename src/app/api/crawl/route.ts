import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export const maxDuration = 300

const BASE = 'https://www.tcatitans.org'

// Always crawl these first — important pages that may be buried deep
const SEED_URLS = [
  BASE,
  `${BASE}/family`,
  `${BASE}/family/school-hoursbell-schedule`,
  `${BASE}/family/dress-code`,
  `${BASE}/family/student-handbook`,
  `${BASE}/family/lunch-information`,
  `${BASE}/family/attendance-absences`,
  `${BASE}/family/supply-lists`,
  `${BASE}/about`,
  `${BASE}/about/staff-directory`,
  `${BASE}/schools/east-elementary`,
  `${BASE}/schools/central-elementary`,
  `${BASE}/schools/north-elementary`,
  `${BASE}/schools/junior-high`,
  `${BASE}/schools/high-school`,
  `${BASE}/schools/college-pathways`,
  `${BASE}/schools/cottage-school`,
  `${BASE}/schools/junior-high/seventh-grade/class-of-2030-welcome-to-junior-high`,
  `${BASE}/schools/high-school/academics`,
  `${BASE}/schools/high-school/athletics`,
  `${BASE}/fs/pages/808`,
  `${BASE}/fs/pages/809`,
]

const SKIP_PATTERNS = [
  '/giving/', '/alumni', '/titan-club', '/tca-moments-blog',
  '/explore-tca/tca-titan-of-the-year', '/explore-tca/tca-moments',
  '/sitemap', '/login', '/logout', '/search', 'const_page=',
  'javascript:', '/uploaded/', '/staff-directory', // handled by ingest-staff
  '/board-of-directors', '/board-minutes', '/governance',
]

const SKIP_EXTS = /\.(jpe?g|png|gif|webp|svg|ico|bmp|zip|doc|xls|ppt|mp4|mp3|mov)(\?.*)?$/i

function shouldSkip(url: string): boolean {
  if (SKIP_EXTS.test(url)) return true
  if (!url.startsWith(BASE)) return true
  return SKIP_PATTERNS.some(p => url.includes(p))
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

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  return m?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
}

function extractLinks(html: string): string[] {
  const links: string[] = []
  for (const m of html.matchAll(/href=["']([^"']+)["']/g)) {
    let href = m[1].trim()
    if (href.startsWith('//')) href = 'https:' + href
    else if (href.startsWith('/')) href = BASE + href
    else if (!href.startsWith('http')) continue
    try {
      const u = new URL(href)
      u.hash = ''
      u.search = ''
      href = u.toString().replace(/\/$/, '')
    } catch { continue }
    if (href.startsWith(BASE)) links.push(href)
  }
  return links
}

function chunkText(text: string, size = 1800, overlap = 200): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    chunks.push(text.slice(start, start + size))
    start += size - overlap
  }
  return chunks
}

function isAuthorized(req: NextRequest): boolean {
  if (req.headers.get('x-vercel-cron') === '1') return true
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret === process.env.CRAWL_SECRET) return true
  return req.headers.get('authorization') === `Bearer ${process.env.CRAWL_SECRET}`
}

async function crawlOne(url: string): Promise<{ text: string; title: string; links: string[] } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TCAHub/1.0)' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const html = await res.text()
    return {
      text: htmlToText(html),
      title: extractTitle(html),
      links: extractLinks(html),
    }
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { VoyageAIClient } = await import('voyageai')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()

  // Delete old general TCA page chunks (leave staff, ical, gobound, teamreach alone)
  await supabase.from('page_chunks')
    .delete()
    .ilike('url', `${BASE}%`)
    .not('url', 'ilike', '%staff-directory%')

  const queue: string[] = [...SEED_URLS]
  const visited = new Set<string>()
  const MAX_PAGES = 250
  const BATCH = 5
  let indexed = 0, skipped = 0, errors = 0

  while (queue.length > 0 && visited.size < MAX_PAGES) {
    // Take next batch of unvisited, valid URLs
    const batch: string[] = []
    while (batch.length < BATCH && queue.length > 0) {
      const url = queue.shift()!
      if (!visited.has(url) && !shouldSkip(url)) {
        visited.add(url)
        batch.push(url)
      }
    }
    if (!batch.length) continue

    // Fetch all pages in batch concurrently
    const results = await Promise.all(batch.map(url => crawlOne(url).then(r => ({ url, r }))))

    // Collect links for BFS
    for (const { r } of results) {
      if (!r) continue
      for (const link of r.links) {
        if (!visited.has(link) && !shouldSkip(link)) queue.push(link)
      }
    }

    // Embed and insert pages with content
    const toEmbed = results.filter(({ r }) => r && r.text.length >= 150)
    if (!toEmbed.length) { skipped += batch.length; continue }

    try {
      const allChunks = toEmbed.flatMap(({ r }) => chunkText(r!.text))
      const embRes = await voyage.embed({
        input: allChunks.map(c => c.slice(0, 16000)),
        model: 'voyage-3-lite',
      })

      let chunkIdx = 0
      for (const { url, r } of toEmbed) {
        const chunks = chunkText(r!.text)
        for (let i = 0; i < chunks.length; i++) {
          const embedding = embRes.data?.[chunkIdx]?.embedding
          chunkIdx++
          if (!embedding) continue
          const { error } = await supabase.from('page_chunks').insert({
            url, title: r!.title, content: chunks[i], embedding, crawled_at: now,
          })
          if (error) errors++; else indexed++
        }
      }
    } catch {
      errors += batch.length
    }

    skipped += batch.length - toEmbed.length
  }

  return NextResponse.json({
    pagesVisited: visited.size,
    indexed,
    skipped,
    errors,
    queueRemaining: queue.length,
  })
}

export async function POST(req: NextRequest) {
  return GET(req)
}
