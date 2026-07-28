import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isCrawlAuthorized } from '@/lib/auth'

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

  // Documents. These are handled by ingest-pdfs, which sends them to Claude to
  // extract properly; this crawler would fetch the same URL, run htmlToText
  // over PDF *binary*, and store the result. It did: 58 chunks across 23
  // documents are byte soup like "%%EOF\r\nxref\r\n0 0\r\ntrailer" under an
  // empty title, embedded and sitting in the search index.
  //
  // The compounding part is what those rows did to ingest-pdfs. It treats any
  // existing row for a document URL as "already indexed", so each of those 23
  // documents was permanently skipped — the garbage version was the only
  // version that would ever exist. A supply list can be crawled into
  // unreadable bytes and thereby made immune to being read.
  '/fs/resource-manager/',

  // Governance and archive. '/board-of-directors' and '/board-minutes' were
  // here already but never matched anything — the real paths are '/board/…'
  // ('/board/board-meeting-agendas-meeting-minutes', '/board/board-highlights'),
  // so 32 chunks of agendas and minutes were being crawled and stored anyway.
  // These mirror the exclusions ingest-pdfs applies to document discovery; both
  // lists exist because this app answers current parent questions, not
  // governance or historical ones.
  '/board/', '/board-of-directors', '/board-minutes', '/governance',
  '/explore-tca/tca-history',
  '/hidden-pages/financial-transparency',
  // The phone-policy page's link list is a screen-time research bibliography —
  // real papers, uploaded by the school, useless for "when is practice".
  '/family/digital-health-in-a-classical-environment',
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
  if (!isCrawlAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { VoyageAIClient } = await import('voyageai')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()

  /* Delete old general TCA page chunks (leave staff, ical, gobound, teamreach
   * alone) — and, now, leave the extracted documents alone too.
   *
   * Documents are served from under this same host as
   * /fs/resource-manager/view/<uuid>, so `ilike '<BASE>%'` matched every one of
   * them. Measured: this delete removed 1,395 rows of which 590 — every single
   * PDF document chunk in the corpus — were ingest-pdfs' work, wiped every
   * Sunday at 03:00. ingest-pdfs then ran at 05:00 and re-extracted what it
   * could reach in one run, paying Claude again for documents it had already
   * read, and the backlog could never converge because the finish line moved
   * back to zero weekly. That is the actual reason the PDF corpus never grew.
   */
  await supabase.from('page_chunks')
    .delete()
    .ilike('url', `${BASE}%`)
    .not('url', 'ilike', '%staff-directory%')
    .not('url', 'ilike', '%/fs/resource-manager/%')

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
