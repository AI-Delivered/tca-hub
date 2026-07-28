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

// The site rate-limits, and harder than the previous note here assumed. Fetching
// the full page list in one sweep at 4-way concurrency was measured returning
// 429 for 102 of 200 pages: the first ~98 succeed, the limiter's bucket empties,
// and every request after that is refused until it refills on a timer. The lost
// half was not random — supply lists, bell schedules, every elementary
// grade-level page and both weekly-announcements pages were in it.
//
// Slowing down enough to fetch all 226 pages politely would cost most of the
// 300s the function is allowed, which is the wrong trade: discovery is not the
// scarce resource here, extraction is. See DISCOVERY_TARGET_DOCS.
const FETCH_CONCURRENCY = 3
const BATCH_PAUSE_MS = 400
// A 429 means the bucket is empty, not that the page is unavailable, so one
// paced retry recovers it. An immediate retry would only spend another token.
const RATE_LIMIT_BACKOFF_MS = 3_000
// If the limiter is refusing this many batches in a row, it is not going to
// recover inside this run. Stop scanning and spend what's left of the clock
// ingesting the documents already queued.
const RATE_LIMIT_GIVE_UP_BATCHES = 4

// Discovery stops once it has this many documents waiting to be ingested.
//
// A run extracts on the order of twenty documents before RUN_BUDGET_MS, so any
// queue longer than that is work this run cannot do anyway — and scanning on to
// build it costs the very minutes the extraction needed. Measured against the
// live site with a 589-document backlog: a full sweep took ~100s and lost half
// its pages to 429s, while stopping at the first full queue took 23s and lost
// none.
const DISCOVERY_TARGET_DOCS = 60
// Hard stop for the scan even if the queue never fills, which is what happens
// once the backlog is genuinely clear and discovery walks the whole site to
// find nothing new. That case is fine and expected; it just must not eat the
// ingest budget on the run where a new document finally appears.
const DISCOVERY_BUDGET_MS = 60_000
// How many documents are extracted at once. See the loop for why.
const DOC_CONCURRENCY = 4

const EXTRACT_PROMPT =
  'Extract all text content from this TCA school document. Include all dates, times, names, grades, events, deadlines, and details. Output as plain structured text.'
const CONTINUE_PROMPT =
  'Continue the extraction from exactly where you stopped. Do not repeat anything already extracted and do not add any preamble.'

// One extraction call. 90s was too tight and would have permanently failed the
// documents that most need extracting: a measured first call on an 85,000-
// character notice took 174s on its own.
const EXTRACTION_TIMEOUT_MS = 180_000
// Rounds of continuation before giving up on a document. The one measured case
// needed two; three leaves room without letting a pathological document eat a
// whole run.
const MAX_EXTRACTION_ROUNDS = 3
// Stop starting new continuation rounds this far into the run, so the function
// returns its report rather than being killed at maxDuration = 300.
const EXTRACTION_DEADLINE_MS = 250_000
// A PDF over this size is assumed to be one of the slow ones and is only
// started early in a run. 400 KB is comfortably above the supply lists and
// letters that make up most of the corpus.
const BIG_PDF_BYTES = 400_000
const BIG_DOC_START_CUTOFF_MS = 40_000

// Leaves headroom under maxDuration so the run reports what it did instead of
// being killed mid-batch. The budget is checked *before* each batch, so a batch
// that starts just under the line still runs to completion: a fetch (up to
// 20s), an extraction (capped at EXTRACTION_TIMEOUT_MS), an embed call and its
// inserts. 170s + that worst case stays under maxDuration = 300; the previous
// 200s did not once a document was allowed to generate 16,000 tokens, and a
// local run overshot 300s, which is what surfaced this.
//
// The run works until the clock runs out and the next one picks up where it
// left off, because already-indexed URLs are skipped.
const RUN_BUDGET_MS = 170_000

interface Discovered {
  url: string
  title: string
}

// PostgREST answers with at most 1,000 rows however large a `limit` you ask
// for, and says nothing about having truncated. Both of this route's url
// lookups outgrew that silently. Paging with an explicit range is the only way
// to know you have all of it: a short page is the end, a full page is not.
const PAGE_SIZE = 1000

async function fetchAllUrls(
  query: (from: number, to: number) => PromiseLike<{ data: { url: string }[] | null }>
): Promise<string[]> {
  const urls: string[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data } = await query(from, from + PAGE_SIZE - 1)
    const rows = data ?? []
    for (const row of rows) urls.push(row.url)
    if (rows.length < PAGE_SIZE) return urls
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TCAHub/1.0)' }

type PageFetch = { html: string } | { rateLimited: boolean }

async function fetchPage(url: string): Promise<PageFetch> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) })
      if (res.ok) return { html: await res.text() }
      if (res.status !== 429) return { rateLimited: false }
      if (attempt === 0) await sleep(RATE_LIMIT_BACKOFF_MS)
    } catch {
      return { rateLimited: false }
    }
  }
  return { rateLimited: true }
}

interface Discovery {
  wanted: Discovered[]
  excluded: Discovered[]
  queue: Discovered[]
  scanned: number
  fetched: number
  failed: number
  rateLimited: number
  stoppedEarly: boolean
}

/**
 * Walks `pages` looking for document links, and stops as soon as it has enough
 * unindexed ones to keep the extraction loop busy for the rest of the run.
 *
 * The queue is built here rather than by the caller for exactly that reason —
 * knowing what is already indexed is what lets the scan know when to stop.
 */
async function discover(pages: string[], indexed: Set<string>, deadline: number): Promise<Discovery> {
  let fetched = 0
  let failed = 0
  let rateLimited = 0
  let consecutiveRateLimitedBatches = 0
  let scanned = 0
  let stoppedEarly = false
  const queue: Discovered[] = []

  // url -> the link's anchor text, which is what the document is actually
  // called ("Central - 2nd Grade Supply List 2026-27") as opposed to the UUID
  // in its URL. The old code captured this and then threw it away, titling
  // every chunk with the last path segment. The page it was found on is kept
  // too, as the last resort for naming an untitled link.
  const found = new Map<string, { text: string; page: string }>()

  for (let i = 0; i < pages.length; i += FETCH_CONCURRENCY) {
    const batch = pages.slice(i, i + FETCH_CONCURRENCY)
    scanned += batch.length
    let batchRateLimited = 0

    await Promise.all(batch.map(async page => {
      const result = await fetchPage(page)
      if (!('html' in result)) {
        failed++
        if (result.rateLimited) { rateLimited++; batchRateLimited++ }
        return /* page unavailable this run — a later run will catch it */
      }
      fetched++
      for (const pattern of LINK_PATTERNS) {
        // Shared regex objects carry lastIndex between uses; matchAll on a
        // /g regex resets it, but be explicit rather than depend on that.
        pattern.lastIndex = 0
        for (const m of result.html.matchAll(pattern)) {
          const href = m[1].startsWith('http') ? m[1] : `https://www.tcatitans.org${m[1]}`
          const text = m[2]
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120)
          if (found.has(href)) continue
          found.set(href, { text, page })
          // Filtered on the raw anchor text, not the cleaned title: the filename
          // and page-name fallbacks could reintroduce a word the blocklist just
          // removed.
          if (isWanted(text) && !indexed.has(href)) {
            queue.push({ url: href, title: cleanTitle(text, href, page) })
          }
        }
      }
    }))

    consecutiveRateLimitedBatches = batchRateLimited === batch.length
      ? consecutiveRateLimitedBatches + 1
      : 0

    if (queue.length >= DISCOVERY_TARGET_DOCS) { stoppedEarly = true; break }
    if (Date.now() > deadline) { stoppedEarly = true; break }
    if (consecutiveRateLimitedBatches >= RATE_LIMIT_GIVE_UP_BATCHES) { stoppedEarly = true; break }

    await sleep(BATCH_PAUSE_MS)
  }

  const wanted: Discovered[] = []
  const excluded: Discovered[] = []
  for (const [url, { text, page }] of found) {
    const entry = { url, title: cleanTitle(text, url, page) }
    ;(isWanted(text) ? wanted : excluded).push(entry)
  }
  return { wanted, excluded, queue, scanned, fetched, failed, rateLimited, stoppedEarly }
}

export async function POST(req: NextRequest) {
  if (!isCrawlAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const startedAt = Date.now()
  const { searchParams } = new URL(req.url)
  // Shows what a real run would ingest without spending a single extraction
  // token — worth having before pointing this at a thousand documents.
  const dryRun = searchParams.get('dryRun') === '1'

  const supabase = getSupabaseAdmin()

  /* Which documents are already in the corpus.
   *
   * This has to be complete or the run does damage rather than nothing: a
   * document missing from this set gets re-fetched, re-extracted by Claude and
   * re-embedded, every single run, forever. The old query relied on PostgREST's
   * default page — which caps at 1,000 rows no matter what — and there are
   * currently 588 document chunks, so it happened to be right. At 3.5 chunks
   * per document the 589-document backlog projects to ~2,660, at which point
   * roughly 60% of the corpus would have looked un-ingested and been paid for
   * again weekly. Same cap that broke page discovery a change ago, one query
   * over; fixed here before it starts costing money rather than after.
   */
  const indexed = new Set(
    await fetchAllUrls((from, to) =>
      supabase.from('page_chunks').select('url')
        .or('url.ilike.%resource-manager%,url.ilike.%finalsite.net%')
        .order('url').range(from, to))
  )

  /* The page list this route crawls for document links.
   *
   * Documents live under tcatitans.org too, so every PDF this route ingests
   * adds chunks matching the same filter. Excluding them in SQL is what stopped
   * the page list from shrinking as the route succeeded — measured mid-backlog,
   * 475 of 1,000 rows were resource-manager chunks and only 93 distinct pages
   * survived, so each successful run discovered less than the one before it.
   */
  const pageUrls = await fetchAllUrls((from, to) =>
    supabase.from('page_chunks').select('url')
      .ilike('url', 'https://www.tcatitans.org/%')
      .not('url', 'ilike', '%/fs/resource-manager/%')
      .order('url').range(from, to))

  const pages = [...new Set(pageUrls.map(u => u.split('#')[0]))]
    .filter(u => !SKIP_PAGE.some(re => re.test(u)))

  /* Where in the page list this run starts.
   *
   * Scanning until the queue fills means always scanning the same alphabetical
   * head, and a document that can never be ingested — a link to a file that
   * 404s, a PDF Claude cannot read — would hold a queue slot indefinitely and
   * keep the scan from ever reaching the pages behind it. Advancing the start
   * each day sweeps the whole site regardless of what is stuck at the front.
   * The stride is coprime with any plausible page count, so consecutive runs
   * land far apart instead of shuffling forward one page at a time.
   */
  const startOffset = pages.length ? (Math.floor(Date.now() / 86_400_000) * 53) % pages.length : 0
  const rotated = [...pages.slice(startOffset), ...pages.slice(0, startOffset)]

  const { wanted, excluded, queue, scanned, fetched, failed, rateLimited, stoppedEarly } =
    await discover(rotated, indexed, startedAt + DISCOVERY_BUDGET_MS)

  const discoveryStats = {
    pagesAvailable: pages.length,
    pagesScannedFrom: startOffset,
    pagesScanned: scanned,
    pagesFetched: fetched,
    pagesFailed: failed,
    pagesRateLimited: rateLimited,
    // True on any healthy run with a backlog: the scan found enough to do and
    // handed the clock to the extraction loop. Only worth attention if it is
    // true *and* nothing got ingested.
    discoveryStoppedEarly: stoppedEarly,
    discoveredOnScannedPages: wanted.length + excluded.length,
    excludedAsNoise: excluded.length,
  }

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      ...discoveryStats,
      alreadyIndexedCorpusWide: indexed.size,
      wouldIngest: queue.length,
      estimatedCostUsd: Number((queue.length * 0.0064).toFixed(2)),
      wouldIngestTitles: queue.map(d => d.title || d.url),
      sampleExcluded: excluded.slice(0, 25).map(d => d.title || d.url),
      elapsedMs: Date.now() - startedAt,
    })
  }

  const { VoyageAIClient } = await import('voyageai')
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  type MessageParam = Parameters<typeof anthropic.messages.create>[0]['messages'][number]

  let indexedCount = 0, skipped = 0, errors = 0, processed = 0
  let ranOutOfTime = false
  // Documents left for a later run rather than stored wrong: `incomplete` ran
  // out of extraction rounds, `deferred` was too big to start this late.
  const incomplete: string[] = []
  const deferred: string[] = []

  /**
   * Fetch one document, extract its text, and store it.
   *
   * Split out of the loop so documents can run concurrently. They share nothing
   * — each writes only rows under its own url, and deletes only its own url
   * first — so the only ordering that ever mattered was the loop's.
   */
  async function ingestOne(doc: Discovered): Promise<void> {
    try {
      const res = await fetch(doc.url, { headers: UA, signal: AbortSignal.timeout(20000) })
      if (!res.ok) { skipped++; return }

      const contentType = res.headers.get('content-type') ?? ''
      const buffer = await res.arrayBuffer()

      let content = ''

      if (contentType.includes('pdf') || doc.url.toLowerCase().endsWith('.pdf')) {
        /* A big document is slow enough to need most of the function to itself.
         *
         * Measured on "Procedural Safeguards": the first extraction call alone
         * took 174s and still stopped at the token ceiling; finishing it took a
         * second call and 198s in total. Started late in a run that overruns
         * maxDuration and the function is killed with nothing returned, so a
         * document this size only starts while there is still real clock left.
         * Skipped, not failed — it stays unindexed and the next run retries it,
         * and the rotating scan start means it won't always land in the same
         * position in the queue.
         */
        if (buffer.byteLength > BIG_PDF_BYTES && Date.now() - startedAt > BIG_DOC_START_CUTOFF_MS) {
          deferred.push(doc.title || doc.url)
          return
        }

        const docBlock = {
          type: 'document' as const,
          source: {
            type: 'base64' as const,
            media_type: 'application/pdf' as const,
            data: Buffer.from(buffer).toString('base64'),
          },
        }

        /* Extraction continues until the model says it is done.
         *
         * max_tokens is a ceiling on one *response*, not on the document, and
         * a document that ran past it was stored as whatever fitted. Raising
         * the ceiling from 2,048 to 16,000 made that rarer without making it
         * impossible: "Procedural Safeguards" is 84,641 characters and the
         * corpus held 43,492 of them — 51% of a special-education rights
         * notice, indistinguishable from a complete short document, and
         * permanently so, because the partial row is what marks the URL
         * indexed and stops it ever being read again.
         *
         * Asking the model to carry on from where it stopped is all it takes;
         * the one measured case needed exactly one extra round.
         */
        let messages: MessageParam[] = [{
          role: 'user',
          content: [docBlock, { type: 'text', text: EXTRACT_PROMPT }],
        }]
        let complete = false
        let rounds = 0

        while (rounds < MAX_EXTRACTION_ROUNDS) {
          rounds++
          const msg = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 16_000,
            messages,
          }, { timeout: EXTRACTION_TIMEOUT_MS })

          const text = msg.content[0]?.type === 'text' ? msg.content[0].text : ''
          content += text

          if (msg.stop_reason !== 'max_tokens') { complete = true; break }
          if (Date.now() - startedAt > EXTRACTION_DEADLINE_MS) break

          messages = [
            ...messages,
            { role: 'assistant', content: text },
            { role: 'user', content: CONTINUE_PROMPT },
          ]
        }

        /* An extraction known to be incomplete is not stored at all.
         *
         * This is the whole point of the change. Storing the partial is what
         * made it permanent: the row marks the URL as indexed, so the document
         * is never queued again and the missing half can never arrive. Leaving
         * it out costs this run the document and gets the next run a clean
         * attempt at the whole thing.
         */
        if (!complete) {
          incomplete.push(doc.title || doc.url)
          console.warn(`ingest-pdfs: extraction still incomplete after ${rounds} rounds, not storing — ${doc.title} (${doc.url})`)
          return
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

      if (!content || content.length < 100) { skipped++; return }

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

  /* Documents run concurrently because extraction is almost entirely waiting.
   *
   * Measured serially: 6 documents in 226s, ~34s each, nearly all of it Claude
   * generating the extracted text. Nothing about that time is this function's
   * work, and the documents are independent, so running them one at a time was
   * simply choosing to wait six times in a row.
   *
   * Four at a time, not more: the run is bounded by the clock rather than by
   * the queue, so extra parallelism past what fills the budget only widens the
   * burst of concurrent API calls without ingesting more.
   */
  for (let i = 0; i < queue.length; i += DOC_CONCURRENCY) {
    if (Date.now() - startedAt > RUN_BUDGET_MS) { ranOutOfTime = true; break }
    const batch = queue.slice(i, i + DOC_CONCURRENCY)
    processed += batch.length
    await Promise.all(batch.map(ingestOne))
  }

  return NextResponse.json({
    ...discoveryStats,
    alreadyIndexedCorpusWide: indexed.size,
    queued: queue.length,
    processed,
    chunksIndexed: indexedCount,
    skipped,
    errors,
    // Only what this run's scan turned up and did not get to. The site-wide
    // backlog is deliberately no longer reported: the scan stops as soon as it
    // has enough to do, so it does not know the total and would be guessing.
    remainingInThisScan: ranOutOfTime ? queue.length - processed : 0,
    // Documents deliberately not stored this run, so nothing here is a partial
    // document sitting in the corpus — these are all retried next run.
    incompleteCount: incomplete.length,
    incompleteDocuments: incomplete,
    deferredAsTooLargeCount: deferred.length,
    deferredAsTooLarge: deferred,
    elapsedMs: Date.now() - startedAt,
  })
}

export async function GET(req: NextRequest) {
  if (!isCrawlAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return POST(req)
}
