import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isCrawlAuthorized } from '@/lib/auth'
import { sanitizeForPostgres } from '@/lib/ingest-chunks'

export const maxDuration = 300

function chunkText(text: string, chunkSize = 1800, overlap = 200): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    chunks.push(text.slice(start, start + chunkSize))
    start += chunkSize - overlap
  }
  return chunks
}

// Documents linked from the school site — supply lists, calendars, codes of
// conduct, enrolment forms, the one-off letters a teacher posts for a single
// grade. Finalsite publishes them two different ways and this used to see only
// one of them:
//
//   /fs/resource-manager/view/<uuid>   proxied through tcatitans.org
//   resources.finalsite.net/…/x.pdf    straight off the CDN
//
// The second pattern was invisible, which is why nothing on that host had ever
// been indexed — including the 6th grade Baroque Shoe Project letter that
// started this.
const LINK_PATTERNS = [
  /<a[^>]+href=["']([^"']*\/fs\/resource-manager\/view\/[a-f0-9-]+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  /<a[^>]+href=["'](https?:\/\/resources\.finalsite\.net\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
]

// Pages whose links are not worth following at all. Four pages account for
// nearly every useless document on the site, and skipping the page is both
// cheaper and more reliable than trying to recognise its documents one by one:
//
//   /board/…              723 agendas, minutes and highlights back to 2023.
//                         No parent has ever asked this app a governance question.
//   tca-history           73 archival documents about the school's founding.
//   financial-transparency 31 budget and audit PDFs — statutory postings, not
//                         things a parent asks about.
//   digital-health…       25 links, but they are the *bibliography* for the
//                         phone policy — "Have smartphones destroyed a
//                         generation?", MRI screen-time studies, Common Sense
//                         Media census. Real research, uploaded by the school,
//                         and completely useless for answering "when does
//                         volleyball practice start".
//
// Deliberately NOT skipped: the per-grade pages. They carry 130+ documents
// between them and they are the single richest source of exactly the thing
// this whole change is about — one-off letters like the 6th grade Baroque
// Shoe Project.
const SKIP_PAGE = [
  /\/board\//i,
  /\/explore-tca\/tca-history/i,
  /\/hidden-pages\/financial-transparency/i,
  /\/family\/digital-health-in-a-classical-environment/i,
]

// Belt and braces for governance documents linked from elsewhere, plus the
// archives: Palmarium is the school literary magazine and its back issues are
// long, numerous, and answer nothing.
//
// This is a blocklist rather than an allowlist on purpose. An allowlist of
// "supply lists, calendars, handbooks" would have missed the shoe project
// letter exactly the way the old regex did — the useful long tail here is
// unanticipated one-offs, so the rule has to be "everything except the noise".
const SKIP_DOC = [
  /\bboard\b[\s\S]*\b(meeting|agenda|minutes|highlight|packet|retreat|work session)\b/i,
  /\b(agenda|minutes|highlights)\b/i,
  /\bpalmarium\b/i,
  /\barticles of incorporation\b/i,

  // Classroom drill material. The elementary grade pages carry ~500 of these —
  // "Addition or Subtraction War Directions", "Number Bond and Fact Family
  // Practice To 10", "Phonogram Sounds 27-50" — which is school content but not
  // the practical answers this app exists to give.
  //
  // Note what is deliberately absent: a bare /\bpractice\b/. "Volleyball
  // practice" is one of the most common questions parents ask, so `practice`
  // only excludes when it appears with drill vocabulary, never on its own.
  /\b(phonogram|spalding|phonics)\b/i,
  /\b(number bond|fact family|math fact)\b/i,
  /\b(multiplication|addition|subtraction)\b/i,
  /\bdirections\b/i,
  /\bgameboard\b/i,
  /^chapter\s*\d+/i,
]

function isWanted(linkText: string): boolean {
  return !SKIP_DOC.some(re => re.test(linkText))
}

// Anchor text that says nothing about the document. These titles end up as the
// source label under an answer — "Download PDF" and a bare CDN URL are both
// worse than nothing there, so fall back to the filename.
const USELESS_TITLE = /^(download|download pdf|click here|here|link|pdf|view|read more|more)$/i

/** "…/grade-level-information/central-elementary-2nd-grade" → "Central Elementary 2nd Grade" */
function pageName(pageUrl: string): string {
  const slug = pageUrl.split('?')[0].replace(/\/$/, '').split('/').pop() ?? ''
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b[a-z]/g, c => c.toUpperCase())
}

function cleanTitle(linkText: string, url: string, sourcePage: string): string {
  const text = linkText
    // Finalsite appends this to accessible links; it is not part of the name.
    .replace(/\(opens in new window\/?(tab)?\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (text && !USELESS_TITLE.test(text) && !/^https?:\/\//i.test(text)) return text

  // Filename next: "2526-CO-SAT-Student-Guide.pdf" reads far better than the
  // full CDN path it came from.
  const file = decodeURIComponent(url.split('?')[0].split('/').pop() ?? '')
  const named = /^[a-f0-9-]{16,}$/i.test(file)
    ? ''
    : file.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (named) return named

  // A resource-manager UUID with "Download PDF" for link text has nothing left
  // to name it by — except the page it was posted on, which is usually exactly
  // what a parent would call it ("Central Elementary 2nd Grade").
  const page = pageName(sourcePage)
  return page ? `${page} — document` : text || url
}

const DISCOVERY_PAGE_LIMIT = 200
// The site rate-limits: at 8-way concurrency a discovery sweep lost 77 of 150
// pages, and every lost page is documents that silently never get found. At 4
// with a pause between batches the same sweep landed 146 of 150.
const FETCH_CONCURRENCY = 4
const BATCH_PAUSE_MS = 200
// Leaves headroom under maxDuration so the run reports what it did instead of
// being killed mid-document. The old fixed cap of 20 documents per weekly run
// meant a 150-document backlog would take two months to clear; this works until
// the clock runs out and the next run picks up where it left off, because
// already-indexed URLs are skipped.
//
// 200s, not 240s, and the gap is deliberate. The budget is checked *before*
// each document, so a document that starts just under the line still runs to
// completion — a fetch (up to 20s), a Claude extraction, an embed call and its
// inserts, comfortably 60s more. At 240s that lands right on maxDuration = 300
// and Vercel kills the function mid-write; a local run overshot 300s and
// tripped the client's own header timeout, which is what surfaced this.
const RUN_BUDGET_MS = 200_000

interface Discovered {
  url: string
  title: string
}

async function discover(pages: string[]): Promise<{ wanted: Discovered[]; excluded: Discovered[]; fetched: number; failed: number }> {
  let fetched = 0
  let failed = 0

  // url -> the link's anchor text, which is what the document is actually
  // called ("Central - 2nd Grade Supply List 2026-27") as opposed to the UUID
  // in its URL. The old code captured this and then threw it away, titling
  // every chunk with the last path segment. The page it was found on is kept
  // too, as the last resort for naming an untitled link.
  const found = new Map<string, { text: string; page: string }>()

  for (let i = 0; i < pages.length; i += FETCH_CONCURRENCY) {
    await Promise.all(pages.slice(i, i + FETCH_CONCURRENCY).map(async page => {
      try {
        const res = await fetch(page, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TCAHub/1.0)' },
          signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) { failed++; return }
        fetched++
        const html = await res.text()
        for (const pattern of LINK_PATTERNS) {
          // Shared regex objects carry lastIndex between uses; matchAll on a
          // /g regex resets it, but be explicit rather than depend on that.
          pattern.lastIndex = 0
          for (const m of html.matchAll(pattern)) {
            const href = m[1].startsWith('http') ? m[1] : `https://www.tcatitans.org${m[1]}`
            const text = m[2]
              .replace(/<[^>]+>/g, ' ')
              .replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&')
              .replace(/&#39;/g, "'")
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 120)
            if (!found.has(href)) found.set(href, { text, page })
          }
        }
      } catch { failed++ /* page unavailable this run — the next one will catch it */ }
    }))
    await new Promise(r => setTimeout(r, BATCH_PAUSE_MS))
  }

  const wanted: Discovered[] = []
  const excluded: Discovered[] = []
  for (const [url, { text, page }] of found) {
    const entry = { url, title: cleanTitle(text, url, page) }
    // Filtered on the raw anchor text, not the cleaned title: the filename and
    // page-name fallbacks could reintroduce a word the blocklist just removed.
    ;(isWanted(text) ? wanted : excluded).push(entry)
  }
  return { wanted, excluded, fetched, failed }
}

export async function POST(req: NextRequest) {
  if (!isCrawlAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const startedAt = Date.now()
  const { searchParams } = new URL(req.url)
  // Shows what a real run would ingest without spending a single extraction
  // token — worth having before pointing this at a thousand documents.
  const dryRun = searchParams.get('dryRun') === '1'

  const supabase = getSupabaseAdmin()

  /* The page list this route crawls for document links.
   *
   * Two things made this shrink as the route succeeded, which is the worst
   * possible direction for it to move.
   *
   * PostgREST caps a response at 1,000 rows regardless of what `limit` asks
   * for, so `.limit(2000)` silently returned 1,000 of 1,356 — a ceiling that
   * looked like it had headroom and did not.
   *
   * Worse, documents live under tcatitans.org too, so every PDF this route
   * ingested added chunks that matched the same filter and consumed rows of
   * that 1,000 before the JS filter could drop them. Measured mid-backlog:
   * 475 of 1,000 rows were resource-manager chunks, leaving 93 distinct pages
   * to scan where there had been 150+. Each successful run therefore found
   * fewer pages, which found fewer documents — a loop that tightened around
   * itself the more work it did.
   *
   * Excluding documents in SQL spends the whole row budget on pages. The
   * ordering makes the truncation predictable rather than arbitrary.
   */
  const { data: pageRows } = await supabase
    .from('page_chunks')
    .select('url')
    .ilike('url', 'https://www.tcatitans.org/%')
    .not('url', 'ilike', '%/fs/resource-manager/%')
    .order('url')
    .limit(1000)

  const pages = [...new Set((pageRows ?? []).map(r => r.url.split('#')[0]))]
    .filter(u => !SKIP_PAGE.some(re => re.test(u)))
    .slice(0, DISCOVERY_PAGE_LIMIT)

  const { wanted, excluded, fetched, failed } = await discover(pages)

  // Which documents are already in the corpus. The old query only looked for
  // '%resource-manager%', so every CDN document would have been re-extracted
  // and re-embedded on every single run — paying for the same PDF weekly.
  const indexed = new Set<string>()
  for (const pattern of ['%resource-manager%', '%finalsite.net%']) {
    const { data } = await supabase.from('page_chunks').select('url').ilike('url', pattern)
    for (const row of data ?? []) indexed.add(row.url)
  }

  const queue = wanted.filter(d => !indexed.has(d.url))

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      pagesScanned: pages.length,
      pagesFetched: fetched,
      pagesFailed: failed,
      discovered: wanted.length + excluded.length,
      wanted: wanted.length,
      excludedAsNoise: excluded.length,
      alreadyIndexed: wanted.length - queue.length,
      wouldIngest: queue.length,
      estimatedCostUsd: Number((queue.length * 0.0064).toFixed(2)),
      wouldIngestTitles: queue.map(d => d.title || d.url),
      sampleExcluded: excluded.slice(0, 25).map(d => d.title || d.url),
    })
  }

  const { VoyageAIClient } = await import('voyageai')
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  let indexedCount = 0, skipped = 0, errors = 0, processed = 0
  let ranOutOfTime = false
  const truncated: string[] = []

  for (const doc of queue) {
    if (Date.now() - startedAt > RUN_BUDGET_MS) { ranOutOfTime = true; break }
    processed++

    try {
      const res = await fetch(doc.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TCAHub/1.0)' },
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) { skipped++; continue }

      const contentType = res.headers.get('content-type') ?? ''
      const buffer = await res.arrayBuffer()

      let content = ''

      if (contentType.includes('pdf') || doc.url.toLowerCase().endsWith('.pdf')) {
        const msg = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          // 2048 was roughly three pages of extracted text, and a document
          // that ran past it was silently cut off mid-sentence — a 30-page
          // handbook became its table of contents, with nothing anywhere
          // saying so. Output is billed per token *generated*, not per token
          // allowed, so a high ceiling costs nothing on the one-page supply
          // lists that make up most of the corpus and simply stops throwing
          // away the long documents.
          max_tokens: 16_000,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: Buffer.from(buffer).toString('base64'),
                },
              },
              {
                type: 'text',
                text: 'Extract all text content from this TCA school document. Include all dates, times, names, grades, events, deadlines, and details. Output as plain structured text.',
              },
            ],
          }],
        })
        content = msg.content[0].type === 'text' ? msg.content[0].text : ''

        // Even at 16k a document can run out of room. The model says so, and
        // the old code never asked — which is the actual defect here, more than
        // the limit itself: silent truncation looks identical to a short
        // document, so the corpus quietly held partial handbooks with no way
        // to tell. Counted and returned, so a run that truncates says so.
        if (msg.stop_reason === 'max_tokens') {
          truncated.push(doc.title || doc.url)
          console.warn(`ingest-pdfs: extraction hit the token ceiling, content is incomplete — ${doc.title} (${doc.url})`)
        }
      } else {
        content = Buffer.from(buffer).toString('utf-8')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      }

      // Claude's extraction of a scanned or oddly-encoded PDF can carry NUL
      // bytes and unpaired surrogates, neither of which Postgres will store.
      // Unsanitised, every chunk of such a document failed to insert, the
      // document never got marked indexed, and the next run picked it up and
      // paid to extract it again — forever.
      content = sanitizeForPostgres(content)

      if (!content || content.length < 100) { skipped++; continue }

      // The link's anchor text, so retrieval and the sources list under an
      // answer show "Central - 2nd Grade Supply List 2026-27" instead of
      // "9b9f4a6c-8b34-41e0-bdcd-35e4b254c8b1".
      const title = doc.title || doc.url.split('/').pop() || doc.url

      await supabase.from('page_chunks').delete().eq('url', doc.url)

      const chunks = chunkText(content)
      const embRes = await voyage.embed({
        input: chunks.map(c => c.slice(0, 16000)),
        model: 'voyage-3-lite',
      })

      for (let i = 0; i < chunks.length; i++) {
        const embedding = embRes.data?.[i]?.embedding
        if (!embedding) continue
        const { error } = await supabase
          .from('page_chunks')
          .insert({ url: doc.url, title, content: chunks[i], embedding })
        if (error) {
          errors++
          if (errors <= 3) console.error(`page_chunks insert failed for ${doc.url}: ${error.message}`)
        } else {
          indexedCount++
        }
      }
    } catch {
      errors++
    }
  }

  return NextResponse.json({
    pagesScanned: pages.length,
    pagesFetched: fetched,
    pagesFailed: failed,
    discovered: wanted.length + excluded.length,
    excludedAsNoise: excluded.length,
    queued: queue.length,
    processed,
    chunksIndexed: indexedCount,
    skipped,
    errors,
    // Says plainly that there is more to do, rather than looking like a clean
    // finish that happened to index fewer documents than expected.
    remaining: ranOutOfTime ? queue.length - processed : 0,
    // Documents whose text was cut off. Should be zero; anything here is a
    // document in the corpus that is only partly there.
    truncatedCount: truncated.length,
    truncatedDocuments: truncated,
    elapsedMs: Date.now() - startedAt,
  })
}

export async function GET(req: NextRequest) {
  if (!isCrawlAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return POST(req)
}
