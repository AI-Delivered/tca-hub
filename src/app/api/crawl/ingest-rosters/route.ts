import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export const maxDuration = 300

const BASE = 'https://gobound.com'
const SOURCE_BASE = 'https://gobound.com/co/schools/theclassahs'
const SCHOOL = 'theclassahs'
const SEASON = '2026-27'

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

function isAuthorized(req: NextRequest): boolean {
  if (req.headers.get('x-vercel-cron') === '1') return true
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret === process.env.CRAWL_SECRET) return true
  return req.headers.get('authorization') === `Bearer ${process.env.CRAWL_SECRET}`
}

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
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
      const embRes = await voyage.embed({ input: [content.slice(0, 16000)], model: 'voyage-3-lite' })
      const embedding = embRes.data?.[0]?.embedding
      if (!embedding) { results.push({ sport: sport.name, status: 'embed-error' }); continue }

      const { error } = await supabase.from('page_chunks').insert({ url: chunkUrl, title, content, embedding, crawled_at: now })
      if (!error) chunksInserted++
      results.push({ sport: sport.name, players: players.length, status: 'ok', sourceUrl: url })
    } catch (e) {
      results.push({ sport: sport.name, status: 'error', error: String(e) })
    }
  }

  return NextResponse.json({ totalPlayers, chunksInserted, results })
}
