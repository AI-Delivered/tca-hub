// Landsharks Running Club — the elementary cross country club.
//
// A third source, and the only one for this. Landsharks runs the club at the
// three TCA elementary campuses and publishes everything about it on its own
// site: coach and contact, practice days and times, where to meet, meet dates
// and locations, race distances by grade, what colour shirt to buy. None of it
// appears on tcatitans.org, GoBound or TeamReach.
//
// The elementary campuses are exactly the ones with no announcements page of
// their own, so their families have the least on the school site and the most
// living elsewhere.

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isCrawlAuthorized } from '@/lib/auth'
import { storeChunks } from '@/lib/ingest-chunks'
import { withIngestLog } from '@/lib/ingest-log'

export const maxDuration = 120

const BASE = 'https://www.landsharksrunningclub.com'

/* Only the three TCA campuses. Landsharks runs clubs at schools across the
 * district; the rest are somebody else's parents. Cottage School has no page —
 * checked, it 404s. */
const TEAMS = [
  { slug: 'tca-east', campus: 'East Elementary' },
  { slug: 'tca-north', campus: 'North Elementary' },
  { slug: 'tca-central', campus: 'Central Elementary' },
]

/* SportsEngine wraps every page in the same safeguarding notice and platform
 * footer — roughly 2,000 characters repeated on all three, which would embed
 * three near-identical chunks that answer nothing. Cut at the first marker that
 * appears, so a wording change costs the trailing text rather than the page. */
const BOILERPLATE_FROM = [
  /Spectator Code of Conduct/i,
  /thank you for all you do for our community/i,
  /This website is powered by SportsEngine/i,
]

function pageText(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|td|th)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ').replace(/&[a-z]+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim()

  // Drop the site's own chrome ahead of the content.
  const start = text.search(/Finishing is Winning|Head Coach|Practice Days/i)
  const body = start > 0 ? text.slice(start) : text

  let end = body.length
  for (const re of BOILERPLATE_FROM) {
    const m = body.search(re)
    if (m > 200 && m < end) end = m
  }
  return body.slice(0, end).trim()
}

async function run(req: NextRequest) {
  if (!isCrawlAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { VoyageAIClient } = await import('voyageai')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()

  const results: { campus: string; chars: number; chunks: number; status: string }[] = []
  const newItems: string[] = []
  let errors = 0

  for (const team of TEAMS) {
    const url = `${BASE}/${team.slug}`
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TCAHub/1.0)' },
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) {
        results.push({ campus: team.campus, chars: 0, chunks: 0, status: `HTTP ${res.status}` })
        errors++
        continue
      }

      const body = pageText(await res.text())
      if (body.length < 200) {
        // Season over, or the page rebuilt. Leave whatever is stored rather
        // than replacing a real answer with an empty one.
        results.push({ campus: team.campus, chars: body.length, chunks: 0, status: 'too thin — kept existing' })
        continue
      }

      const existing = await supabase.from('page_chunks').select('url').eq('url', url).limit(1)
      const isNew = !(existing.data ?? []).length

      /* Stamped with the campus, like the newsletters. The title carries it but
       * the title is not what gets embedded, and these three pages are close to
       * identical — same club, same format, different coach and times. Without
       * this a North parent's question matches East's practice times as well as
       * their own. */
      const stamped = `Landsharks Running Club — cross country at TCA ${team.campus}.\n\n${body}`

      await supabase.from('page_chunks').delete().eq('url', url)
      const stored = await storeChunks(
        supabase, voyage,
        { url, title: `Landsharks Cross Country — ${team.campus}`, content: stamped },
        now
      )
      errors += stored.errors
      results.push({ campus: team.campus, chars: body.length, chunks: stored.inserted, status: 'ok' })
      if (isNew && stored.inserted) newItems.push(`Landsharks Cross Country — ${team.campus}`)
    } catch (e) {
      errors++
      results.push({ campus: team.campus, chars: 0, chunks: 0, status: e instanceof Error ? e.message : 'failed' })
      console.error(`ingest-landsharks: ${url} failed:`, e instanceof Error ? e.message : e)
    }
  }

  return NextResponse.json({
    results,
    chunksInserted: results.reduce((n, r) => n + r.chunks, 0),
    errors,
    newDocumentCount: newItems.length,
    newDocuments: newItems,
  })
}

function handler(req: NextRequest) {
  return withIngestLog(req, '/api/crawl/ingest-landsharks', () => run(req))
}

export const GET = handler
export const POST = handler
