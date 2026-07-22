import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export const maxDuration = 300

const BOUND_HOME = 'https://www.gobound.com/co/schools/theclassahs'

function isAuthorized(req: NextRequest): boolean {
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret === process.env.CRAWL_SECRET) return true
  return req.headers.get('authorization') === `Bearer ${process.env.CRAWL_SECRET}`
}

interface GameEntry {
  sport: string
  date: string
  opponent: string
  time: string
  location: string
  result: string
}

// Extract program links + sport names from main page markdown
function extractPrograms(md: string): Array<{ name: string; url: string }> {
  const seen = new Set<string>()
  const programs: Array<{ name: string; url: string }> = []
  for (const m of md.matchAll(/\[!\[\][^\]]*\\\n([^\]]+)\]\((https:\/\/www\.gobound\.com\/direct\/programs\/[^)]+)\)/g)) {
    if (!seen.has(m[2])) {
      seen.add(m[2])
      programs.push({ name: m[1].trim(), url: m[2] })
    }
  }
  return programs
}

// Extract schedule link and schedule data from a program page
function extractScheduleUrl(md: string): string | null {
  const m = md.match(/\[Schedule\]\((https:\/\/www\.gobound\.com\/co\/chsaa\/[^)]+\/schedule)\)/)
  return m?.[1] ?? null
}

// Parse game table from schedule page markdown
function parseSchedule(sport: string, md: string): GameEntry[] {
  const games: GameEntry[] = []
  // Table rows: | Date | Opponent | Result | ... | Location | ...
  // Pattern: | date | opponent name | result/time | ... | location |
  for (const m of md.matchAll(/\|\s*(\d+\/\d+\/\d+)\s*\|[^|]*\[([^\]]+)\][^|]*\|\s*\[?([^|\]]+)\]?[^|]*\|[^|]*\|[^|]*([^|]*)\|/g)) {
    const date = m[1].trim()
    const opponent = m[2].trim()
    const timeOrResult = m[3].trim()
    const location = m[4].trim()
    // Skip image refs
    if (opponent.startsWith('!')) continue
    games.push({ sport, date, opponent, time: timeOrResult, location, result: '' })
  }
  return games
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { VoyageAIClient } = await import('voyageai')
  const { default: FirecrawlApp } = await import('@mendable/firecrawl-js')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY })
  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()

  // 1. Scrape main page → get sport list + index it
  const mainResult = await firecrawl.scrapeUrl(BOUND_HOME, { formats: ['markdown'], waitFor: 3000 })
  const mainMd = mainResult?.markdown ?? ''
  const programs = extractPrograms(mainMd)

  // 2. For each program, scrape it to get schedule URL
  const allGames: GameEntry[] = []
  const scheduleUrls = new Set<string>()
  const sportNames = new Map<string, string>() // scheduleUrl → sport name

  for (const prog of programs) {
    // Skip non-sports
    if (['Band', 'Choir', 'Drama', 'Speech/Debate', 'Student Council'].includes(prog.name)) continue
    try {
      const r = await firecrawl.scrapeUrl(prog.url, { formats: ['markdown'], waitFor: 2000 })
      const md = r?.markdown ?? ''

      // Get sport name from the page title
      const titleMatch = md.match(/####\s+The Classical Academy[^\n]+\n\n([A-Z][A-Z\s/&]+(?:Varsity|Junior|Squad|Team)?)/m)
      const sportName = titleMatch?.[1]?.trim() ?? prog.name

      const schedUrl = extractScheduleUrl(md)
      if (schedUrl && !scheduleUrls.has(schedUrl)) {
        scheduleUrls.add(schedUrl)
        sportNames.set(schedUrl, sportName || prog.name)
      }
    } catch {
      // skip
    }
  }

  // 3. Scrape each schedule page
  for (const schedUrl of scheduleUrls) {
    const sport = sportNames.get(schedUrl) ?? 'Athletics'
    try {
      const r = await firecrawl.scrapeUrl(schedUrl, { formats: ['markdown'], waitFor: 2000 })
      const md = r?.markdown ?? ''
      const games = parseSchedule(sport, md)
      allGames.push(...games)
    } catch {
      // skip
    }
  }

  // 4. Delete old Bound chunks and index fresh content
  await supabase.from('page_chunks').delete().ilike('url', '%gobound%')

  // Index the main page as a sports overview chunk
  const sportsListMd = programs.map(p => `- ${p.name}`).join('\n')
  const overviewContent = `TCA Classical Academy Athletics & Activities (from gobound.com):\n\n${sportsListMd}\n\nFor schedules, rosters, and results visit: ${BOUND_HOME}`
  const overviewEmb = await voyage.embed({ input: [overviewContent], model: 'voyage-3-lite' })
  await supabase.from('page_chunks').insert({
    url: BOUND_HOME,
    title: 'TCA Athletics & Activities',
    content: overviewContent,
    embedding: overviewEmb.data![0].embedding!,
    crawled_at: now,
  })

  // Index games grouped by sport
  const bySport: Record<string, GameEntry[]> = {}
  for (const g of allGames) {
    if (!bySport[g.sport]) bySport[g.sport] = []
    bySport[g.sport].push(g)
  }

  let schedChunks = 0
  for (const [sport, games] of Object.entries(bySport)) {
    const lines = [`${sport} 2026-27 Schedule:`]
    for (const g of games) {
      lines.push(`  ${g.date} vs ${g.opponent}${g.time ? ' @ ' + g.time : ''}${g.location ? ' — ' + g.location : ''}${g.result ? ' [' + g.result + ']' : ''}`)
    }
    const content = lines.join('\n')
    const sportUrl = `${BOUND_HOME}#${sport.toLowerCase().replace(/[\s/&]+/g, '-')}`
    const emb = await voyage.embed({ input: [content.slice(0, 16000)], model: 'voyage-3-lite' })
    const { error } = await supabase.from('page_chunks').insert({
      url: sportUrl,
      title: `TCA ${sport} Schedule 2026-27`,
      content,
      embedding: emb.data![0].embedding!,
      crawled_at: now,
    })
    if (!error) schedChunks++
  }

  return NextResponse.json({
    programsFound: programs.length,
    scheduleUrlsFound: scheduleUrls.size,
    gamesFound: allGames.length,
    sportsWithGames: Object.keys(bySport).length,
    chunksInserted: schedChunks + 1,
  })
}
