import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isCrawlAuthorized } from '@/lib/auth'
import { fetchAllUrls } from '@/lib/page-urls'

export const maxDuration = 300

// A full pass over the site measured 400 pages in ~180s. This leaves room for
// the site to grow before the function is killed, and — more to the point —
// means a run that does hit the ceiling returns a report saying so.
const RUN_BUDGET_MS = 240_000

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

  const startedAt = Date.now()
  const { VoyageAIClient } = await import('voyageai')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()

  /* This route used to delete every page chunk before crawling anything.
   *
   * Two things wrong with that. Documents are served from under this same host
   * as /fs/resource-manager/view/<uuid>, so `ilike '<BASE>%'` matched all of
   * them: the delete removed 1,395 rows of which 590 — every extracted document
   * in the corpus — were ingest-pdfs' work, wiped every Sunday at 03:00 and
   * re-paid for two hours later. That part was fixed by excluding them.
   *
   * The shape was still wrong, though. Deleting up front means the corpus is
   * empty until the rebuild finishes, so a run that is killed at maxDuration
   * leaves it holding whatever it happened to have re-crawled — and this route
   * now visits 400 pages in ~180s where it used to give up at 250, so there is
   * real headroom being used. Each page replaces its own rows as it is indexed
   * instead, which means an interrupted run leaves the corpus stale rather than
   * gutted. Pages that have genuinely disappeared from the site are swept at
   * the end, and only when the crawl actually finished — see below.
   */

  /* The queue used to be pushed to without checking whether a URL was already
   * on it, and deduplicated only when popped.
   *
   * Every page on this site carries the full navigation, so every page crawled
   * pushed the same ~57 links again. Measured on a real run: after 250 pages
   * the queue held 14,302 entries and exactly 250 distinct URLs — 98% of it was
   * the same handful repeated. The route reported `queueRemaining: 10778`,
   * which read as "10,778 pages still to crawl" and was nothing of the sort.
   *
   * `queued` tracks membership so a URL is enqueued once, and what the route
   * reports afterwards is a count of real pages rather than of duplicates.
   */
  const queue: string[] = [...SEED_URLS]
  const queued = new Set<string>(SEED_URLS)
  const visited = new Set<string>()
  // ~500 pages are reachable once duplicates are out of the way, so 250 was
  // cutting the site in half — and because this route deletes before it
  // rebuilds, the half that survived was whichever half breadth-first order
  // happened to reach, which is not stable between runs. A 250-page pass took
  // 79s, so 600 leaves headroom under maxDuration = 300 and room for the site
  // to grow before the cap starts silently truncating again.
  const MAX_PAGES = 600
  const BATCH = 5
  let indexed = 0, skipped = 0, errors = 0
  let ranOutOfTime = false

  while (queue.length > 0 && visited.size < MAX_PAGES) {
    // Checked before a batch, not during: a batch that starts under the line
    // still finishes, which is a fetch plus an embed call, not minutes.
    if (Date.now() - startedAt > RUN_BUDGET_MS) { ranOutOfTime = true; break }
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
        if (visited.has(link) || queued.has(link) || shouldSkip(link)) continue
        queued.add(link)
        queue.push(link)
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
        // Replace this page's rows, now that nothing was cleared up front.
        await supabase.from('page_chunks').delete().eq('url', url)
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

  // A non-zero `pagesNotReached` means MAX_PAGES cut the crawl short and the
  // corpus is missing pages the site links to — worth acting on, unlike the old
  // `queueRemaining`, which counted duplicates and was never zero.
  const notReached = queue.filter(u => !visited.has(u)).length
  const complete = !ranOutOfTime && notReached === 0 && visited.size < MAX_PAGES

  /* Pages that have gone from the site.
   *
   * Only swept when the crawl actually finished. A run that stopped early did
   * not fail to find these pages because they are gone — it failed to find them
   * because it stopped, and deleting them on that basis would turn a slow run
   * into data loss. Staff and document rows belong to other routes and are
   * never touched here.
   */
  let staleRemoved = 0
  if (complete) {
    const known = await fetchAllUrls((from, to) =>
      supabase.from('page_chunks').select('url')
        .ilike('url', `${BASE}%`)
        .not('url', 'ilike', '%staff-directory%')
        .not('url', 'ilike', '%/fs/resource-manager/%')
        .order('url').range(from, to))

    for (const url of new Set(known)) {
      if (visited.has(url)) continue
      const { error } = await supabase.from('page_chunks').delete().eq('url', url)
      if (!error) staleRemoved++
    }
  }

  return NextResponse.json({
    pagesVisited: visited.size,
    hitPageLimit: visited.size >= MAX_PAGES,
    pagesNotReached: notReached,
    ranOutOfTime,
    indexed,
    skipped,
    errors,
    stalePagesRemoved: staleRemoved,
    elapsedMs: Date.now() - startedAt,
  })
}

export async function POST(req: NextRequest) {
  return GET(req)
}
