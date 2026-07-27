import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isCrawlAuthorized } from '@/lib/auth'
import { storeChunks } from '@/lib/ingest-chunks'

export const maxDuration = 300

const BASE = 'https://gobound.com'
const SOURCE_BASE = 'https://gobound.com/co/schools/theclassahs'
const SCHOOL = 'theclassahs'
// GoBound labels seasons "2026-27", running Aug–Jun. Derived rather than pinned:
// a hardcoded season keeps scraping last year's rosters once the next one starts,
// and does it silently — the pages return empty, which looks like the off-season.
function currentSeason(): string {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }))
  const start = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1
  return `${start}-${String(start + 1).slice(2)}`
}
const SEASON = currentSeason()

const SPORTS = [
  { name: 'Boys Football', code: 'fb', level: 'v' },
  { name: 'Boys Basketball', code: 'bbb', level: 'v' },
  { name: 'Boys Baseball', code: 'bs', level: 'v' },
  { name: 'Boys Soccer', code: 'bsc', level: 'v' },
  { name: 'Boys Golf', code: 'bgf', level: 'v' },
  { name: 'Boys Cross Country', code: 'bxc', level: 'v' },
  { name: 'Boys Track & Field', code: 'btf', level: 'v' },
  { name: 'Boys Wrestling', code: 'wrst', level: 'v' },
  { name: 'Girls Basketball', code: 'gbb', level: 'v' },
  { name: 'Girls Volleyball', code: 'volleyball', level: 'v' },
  { name: 'Girls Soccer', code: 'gsc', level: 'v' },
  { name: 'Girls Softball', code: 'sb', level: 'v' },
  { name: 'Girls Flag Football', code: 'gff', level: 'v' },
  { name: 'Girls Golf', code: 'ggf', level: 'v' },
  { name: 'Girls Cross Country', code: 'gxc', level: 'v' },
  { name: 'Girls Track & Field', code: 'gtf', level: 'v' },
]

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': 'https://gobound.com/',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Upgrade-Insecure-Requests': '1',
    },
  })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.text()
}

interface Player {
  number: string
  name: string
  year: string
  extra: string[]
}

function parseRoster(html: string): Player[] {
  const players: Player[] = []
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i)
  if (!tableMatch) return players

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let rowMatch
  let isFirst = true
  while ((rowMatch = rowRe.exec(tableMatch[0])) !== null) {
    if (isFirst) { isFirst = false; continue } // skip header row
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(c => c[1].replace(/<[^>]+>/g, '').trim())
    const name = cells[1]
    if (!name) continue
    players.push({
      number: cells[0] ?? '',
      name,
      year: cells[2] ?? '',
      extra: cells.slice(3).filter(Boolean),
    })
  }
  return players
}

export async function GET(req: NextRequest) {
  if (!isCrawlAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { VoyageAIClient } = await import('voyageai')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()

  await supabase.from('page_chunks').delete().ilike('url', `${SOURCE_BASE}/roster%`)

  const results = []
  let totalPlayers = 0
  let chunksInserted = 0

  // Fetch all roster pages concurrently
  const fetched = await Promise.allSettled(
    SPORTS.map(async (sport) => {
      const url = `${BASE}/co/chsaa/${sport.code}/${SEASON}/${SCHOOL}/${sport.level}/roster`
      const html = await fetchPage(url)
      return { sport, url, html }
    })
  )

  for (const result of fetched) {
    if (result.status === 'rejected') {
      results.push({ sport: 'unknown', status: 'fetch-error', error: result.reason?.message })
      continue
    }

    const { sport, url, html } = result.value
    const players = parseRoster(html)

    if (!players.length) {
      results.push({ sport: sport.name, players: 0, status: 'empty' })
      continue
    }

    totalPlayers += players.length

    const lines = [`TCA ${sport.name} ${SEASON} Roster:`]
    for (const p of players) {
      const parts = []
      if (p.number) parts.push(`#${p.number}`)
      parts.push(p.name)
      if (p.year) parts.push(p.year)
      if (p.extra.length) parts.push(p.extra.join(', '))
      lines.push('  ' + parts.join(' | '))
    }
    const content = lines.join('\n')
    const chunkUrl = `${SOURCE_BASE}/roster#${sport.name.toLowerCase().replace(/\s+/g, '-')}`
    const title = `TCA ${sport.name} ${SEASON} Roster`

    try {
      // A varsity roster fits in one chunk today. A full football roster with
      // heights, positions and hometowns will not, and the old single-embed
      // path would have silently made everything past 16,000 characters
      // unsearchable — see src/lib/ingest-chunks.ts.
      const stored = await storeChunks(supabase, voyage, { url: chunkUrl, title, content }, now)
      if (!stored.inserted) { results.push({ sport: sport.name, status: 'embed-error' }); continue }

      chunksInserted += stored.inserted
      results.push({ sport: sport.name, players: players.length, chunks: stored.inserted, status: 'ok', sourceUrl: url })
    } catch (e) {
      results.push({ sport: sport.name, status: 'error', error: String(e) })
    }
  }

  return NextResponse.json({ totalPlayers, chunksInserted, results })
}
