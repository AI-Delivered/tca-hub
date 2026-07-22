import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export const maxDuration = 300

const HUDL_BASE = 'https://fan.hudl.com/usa/co/colorado-springs/organization/1538/classical-academy/schedule'

function weekUrl(date: Date): string {
  return `${HUDL_BASE}?date=${date.toISOString()}&range=Week`
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

// Extract event lines from Hudl markdown
// Returns array of strings like "Boys Varsity Football VS Summer Scrimmage — Fri, Jul 24, 2026 @ 11:00 AM"
function extractEvents(markdown: string): string[] {
  const events: string[] = []
  const lines = markdown.split('\n').map(l => l.trim()).filter(Boolean)

  // Pattern: sport line followed by VS line and date/time line
  let sport = ''
  let vs = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Sport name lines — e.g. "Boys Varsity Football"
    if (/^(Boys|Girls|Men's|Women's|Co-ed|JV|Varsity|Freshman|Junior|Middle)/i.test(line) && !line.startsWith('VS') && !line.includes('@')) {
      sport = line
      vs = ''
    }

    // Opponent — "VS Summer Scrimmage"
    if (line.startsWith('VS ')) {
      vs = line
    }

    // Date+time — "Fri, Jul 24, 2026 @ 11:00 AM"
    if (/\w+,\s+\w+\s+\d+,\s+\d{4}\s+@\s+\d+:\d+/.test(line)) {
      if (sport) {
        events.push(`${sport} ${vs} — ${line}`)
        vs = ''
      }
    }
  }
  return events
}

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRAWL_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { default: FirecrawlApp } = await import('@mendable/firecrawl-js')
  const { VoyageAIClient } = await import('voyageai')
  const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY })
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const supabase = getSupabaseAdmin()

  // Scrape every week from now through May 2027
  const startDate = new Date()
  startDate.setHours(0, 0, 0, 0)
  const endDate = new Date('2027-05-31')

  const allEvents: string[] = []
  const seenEvents = new Set<string>()
  let weeksScraped = 0
  let weeksWithContent = 0

  let cursor = new Date(startDate)
  while (cursor <= endDate) {
    const url = weekUrl(cursor)
    try {
      const result = await firecrawl.scrapeUrl(url, { formats: ['markdown'], waitFor: 2000 })
      const md = result?.markdown ?? ''
      if (md.length > 200) {
        const events = extractEvents(md)
        for (const ev of events) {
          if (!seenEvents.has(ev)) {
            seenEvents.add(ev)
            allEvents.push(ev)
          }
        }
        if (events.length > 0) weeksWithContent++
      }
    } catch {
      // skip failed weeks
    }
    weeksScraped++
    cursor = addDays(cursor, 7)
  }

  if (allEvents.length === 0) {
    return NextResponse.json({ message: 'No events found', weeksScraped })
  }

  // Bundle all events into a single chunk (and per-sport chunks if large)
  const pageUrl = HUDL_BASE
  const pageTitle = 'TCA Athletics Schedule'
  const now = new Date().toISOString()

  // Delete existing Hudl chunks
  await supabase.from('chunks').delete().eq('url', pageUrl)

  // Group by sport for more useful retrieval
  const bySport: Record<string, string[]> = {}
  for (const ev of allEvents) {
    const sport = ev.split(' VS ')[0].trim()
    if (!bySport[sport]) bySport[sport] = []
    bySport[sport].push(ev)
  }

  let inserted = 0
  for (const [sport, evList] of Object.entries(bySport)) {
    const content = `TCA ${sport} schedule:\n${evList.join('\n')}`
    const sportUrl = `${pageUrl}#${sport.toLowerCase().replace(/\s+/g, '-')}`

    await supabase.from('chunks').delete().eq('url', sportUrl)

    const embRes = await voyage.embed({ input: [content.slice(0, 16000)], model: 'voyage-3-lite' })
    const embedding = embRes.data![0].embedding!

    const { error } = await supabase.from('chunks').insert({
      url: sportUrl,
      title: `${pageTitle} — ${sport}`,
      content,
      embedding,
      crawled_at: now,
    })
    if (!error) inserted++
  }

  // Also insert a summary chunk for "what sports does TCA offer"
  const summary = `TCA Classical Academy offers the following sports:\n${Object.keys(bySport).join('\n')}\n\nFull schedule available at ${pageUrl}`
  const summaryUrl = `${pageUrl}#summary`
  await supabase.from('chunks').delete().eq('url', summaryUrl)
  const embRes2 = await voyage.embed({ input: [summary], model: 'voyage-3-lite' })
  const { error: e2 } = await supabase.from('chunks').insert({
    url: summaryUrl,
    title: `${pageTitle} — Sports Overview`,
    content: summary,
    embedding: embRes2.data![0].embedding!,
    crawled_at: now,
  })
  if (!e2) inserted++

  return NextResponse.json({
    message: 'Hudl schedule ingested',
    weeksScraped,
    weeksWithContent,
    eventsFound: allEvents.length,
    sportsFound: Object.keys(bySport).length,
    chunksInserted: inserted,
  })
}
