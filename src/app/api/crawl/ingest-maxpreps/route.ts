import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isCrawlAuthorized } from '@/lib/auth'
import { storeChunks } from '@/lib/ingest-chunks'
import { withIngestLog } from '@/lib/ingest-log'
import { identifiesSchool } from '@/lib/school-identity'
import { readStatsPage, statsToText, totalRows, MIN_STAT_ROWS } from '@/lib/maxpreps'

export const maxDuration = 300

/* MaxPreps, for the numbers the school's own system does not carry.
 *
 * GoBound is TCA's system and its statistics are largely empty; MaxPreps is where
 * the football numbers actually are. Two things are worth knowing before this runs
 * anywhere near production.
 *
 * It is somebody else's site. MaxPreps is a CBS Sports property whose terms
 * restrict automated collection. One page once a day is a modest ask and the
 * request identifies itself as an ordinary browser the way this repo's other
 * scrapes do, but the school could also ask MaxPreps directly, and that is the
 * version nobody has to think about again.
 *
 * And nobody here has seen the page. The environment this was written in cannot
 * reach maxpreps.com, so the parser is written against the shapes such a page can
 * take rather than against markup anyone has read. That is why the first thing to
 * run is `?dryRun=1`, which reads the page, reports exactly what came back, and
 * stores nothing.
 */
const SPORTS: Record<string, { label: string; url: string }> = {
  football: {
    label: 'Boys Football',
    url: 'https://www.maxpreps.com/co/colorado-springs/the-classical-academy-titans/football/stats/',
  },
  // More sports go here once the football page has been read successfully — the
  // URLs are the same shape, and there is no point multiplying an unverified guess.
}

/** Same derivation as ingest-stats and ingest-rosters, so seasons agree across sources. */
function currentSeason(): string {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }))
  const start = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1
  return `${start}-${String(start + 1).slice(2)}`
}

async function fetchPage(url: string): Promise<{ html: string; status: number }> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
    },
  })
  return { html: await res.text(), status: res.status }
}

async function run(req: NextRequest) {
  if (!isCrawlAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { VoyageAIClient } = await import('voyageai')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()
  const season = currentSeason()

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'
  const only = req.nextUrl.searchParams.get('sport')
  const override = req.nextUrl.searchParams.get('url')

  const targets = Object.entries(SPORTS)
    .filter(([key]) => !only || key === only)
    .map(([key, sport]) => ({ key, ...sport, url: override && (!only || key === only) ? override : sport.url }))

  if (!targets.length) {
    return NextResponse.json({ error: `unknown sport — known: ${Object.keys(SPORTS).join(', ')}` }, { status: 400 })
  }

  const results = []
  let chunksInserted = 0
  let problems = 0

  for (const target of targets) {
    let page: { html: string; status: number }
    try {
      page = await fetchPage(target.url)
    } catch (e) {
      problems++
      results.push({ sport: target.label, status: 'fetch-failed', detail: String(e instanceof Error ? e.message : e), url: target.url })
      continue
    }

    const reading = readStatsPage({
      html: page.html,
      status: page.status,
      identifiesSchool: identifiesSchool(page.html).identified,
    })

    /* Every way this fails is reported as the thing it is, and none of them writes
     * a row. A thin page stored quietly is how a corpus starts answering questions
     * from an advert. */
    if (reading.problem || totalRows(reading.tables) < MIN_STAT_ROWS) {
      problems++
      results.push({
        sport: target.label,
        status: reading.problem ?? 'too-thin',
        detail: reading.detail ?? `only ${totalRows(reading.tables)} stat row(s) found, fewer than the ${MIN_STAT_ROWS} ` +
          'a real squad page carries — nothing stored',
        url: target.url,
        shape: reading.shape,
      })
      continue
    }

    const content = statsToText({
      sport: target.label, season, tables: reading.tables,
      sourceUrl: target.url, fetchedOn: now.slice(0, 10),
    })
    // Titled like ingest-stats' chunks so both sources of the same fact look alike
    // to retrieval, and named for MaxPreps so an answer can say where it came from.
    const title = `TCA ${target.label} ${season} Stats — MaxPreps`

    if (dryRun) {
      results.push({
        sport: target.label, status: 'dryRun', url: target.url,
        categories: reading.tables.map(t => `${t.category} (${t.rows.length})`),
        rows: totalRows(reading.tables),
        shape: reading.shape,
        preview: content.slice(0, 800),
      })
      continue
    }

    try {
      /* This route's own rows and nothing else — anchored on the exact URL rather
       * than a prefix. The wildcard version of this delete is what let
       * ingest-calendar erase ingest-ical's athletics chunks nightly for as long as
       * both routes existed. */
      await supabase.from('page_chunks').delete().eq('url', target.url)
      const stored = await storeChunks(supabase, voyage, { url: target.url, title, content }, now)
      chunksInserted += stored.inserted
      results.push({
        sport: target.label, status: stored.inserted ? 'ok' : 'embed-error',
        chunks: stored.inserted, rows: totalRows(reading.tables),
        categories: reading.tables.map(t => t.category), url: target.url,
      })
      if (!stored.inserted) problems++
    } catch (e) {
      problems++
      results.push({ sport: target.label, status: 'store-failed', detail: String(e), url: target.url })
    }
  }

  // `errors` is what the dashboard reads off a run, and a page that could not be
  // read is exactly what someone needs to see — daily, until it is fixed or removed.
  return NextResponse.json({ chunksInserted, errors: problems, dryRun, season, results })
}

function handler(req: NextRequest) {
  return withIngestLog(req, '/api/crawl/ingest-maxpreps', () => run(req))
}

export const GET = handler
