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
      'Upgrade-Requests': '1',
    },
  })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.text()
}

interface StatTable {
  category: string
  headers: string[]
  rows: string[][]
}

function parseStats(html: string): StatTable[] {
  const tables: StatTable[] = []

  // Find section headings followed by tables
  // gobound renders: <h2>Passing</h2> ... <table>...</table>
  const sectionRe = /<(?:h[1-4]|div[^>]*class="[^"]*(?:stat-header|section-title)[^"]*")[^>]*>([\s\S]*?)<\/(?:h[1-4]|div)>([\s\S]*?)<table[\s\S]*?<\/table>/gi
  let m
  while ((m = sectionRe.exec(html)) !== null) {
    const category = m[1].replace(/<[^>]+>/g, '').trim()
    const tableHtml = m[0].match(/<table[\s\S]*?<\/table>/i)?.[0] ?? ''
    if (!tableHtml || !category) continue

    const rows = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    if (rows.length < 2) continue

    const headers = [...rows[0][1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
      .map(c => c[1].replace(/<[^>]+>/g, '').trim())

    const dataRows: string[][] = []
    for (let i = 1; i < rows.length; i++) {
      const cells = [...rows[i][1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
        .map(c => c[1].replace(/<[^>]+>/g, '').trim())
      const athlete = cells[0]
      if (!athlete || athlete.toLowerCase() === 'team') continue
      // Skip rows that are all zeros
      const stats = cells.slice(1)
      if (stats.every(v => v === '0' || v === '0.0' || v === '0.0%' || v === '0/0' || v === '')) continue
      dataRows.push(cells)
    }

    if (dataRows.length > 0) {
      tables.push({ category, headers, rows: dataRows })
    }
  }

  // Fallback: try plain table parsing if section regex matched nothing
  if (tables.length === 0) {
    const tableRe = /<table[\s\S]*?<\/table>/gi
    let tm
    while ((tm = tableRe.exec(html)) !== null) {
      const rows = [...tm[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
      if (rows.length < 2) continue
      const headers = [...rows[0][1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
        .map(c => c[1].replace(/<[^>]+>/g, '').trim())
      const dataRows: string[][] = []
      for (let i = 1; i < rows.length; i++) {
        const cells = [...rows[i][1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
          .map(c => c[1].replace(/<[^>]+>/g, '').trim())
        if (!cells[0] || cells[0].toLowerCase() === 'team') continue
        const stats = cells.slice(1)
        if (stats.every(v => v === '0' || v === '0.0' || v === '0.0%' || v === '0/0' || v === '')) continue
        dataRows.push(cells)
      }
      if (dataRows.length > 0) {
        tables.push({ category: headers[0] ?? 'Stats', headers, rows: dataRows })
      }
    }
  }

  return tables
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { VoyageAIClient } = await import('voyageai')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()

  await supabase.from('page_chunks').delete().ilike('url', `${SOURCE_BASE}/stats%`)

  const results = []
  let chunksInserted = 0

  const fetched = await Promise.allSettled(
    SPORTS.map(async (sport) => {
      const url = `${BASE}/co/chsaa/${sport.code}/${SEASON}/${SCHOOL}/${sport.level}/stats`
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
    const tables = parseStats(html)

    if (!tables.length) {
      results.push({ sport: sport.name, status: 'no-stats' })
      continue
    }

    const lines = [`TCA ${sport.name} ${SEASON} Statistics:`]
    for (const table of tables) {
      lines.push(`\n${table.category}:`)
      lines.push('  ' + table.headers.join(' | '))
      for (const row of table.rows) {
        lines.push('  ' + row.join(' | '))
      }
    }
    const content = lines.join('\n')
    const chunkUrl = `${SOURCE_BASE}/stats#${sport.name.toLowerCase().replace(/\s+/g, '-')}`
    const title = `TCA ${sport.name} ${SEASON} Stats`

    try {
      const embRes = await voyage.embed({ input: [content.slice(0, 16000)], model: 'voyage-3-lite' })
      const embedding = embRes.data?.[0]?.embedding
      if (!embedding) { results.push({ sport: sport.name, status: 'embed-error' }); continue }

      const { error } = await supabase.from('page_chunks').insert({ url: chunkUrl, title, content, embedding, crawled_at: now })
      if (!error) chunksInserted++
      results.push({ sport: sport.name, status: 'ok', categories: tables.map(t => t.category), sourceUrl: url })
    } catch (e) {
      results.push({ sport: sport.name, status: 'error', error: String(e) })
    }
  }

  return NextResponse.json({ chunksInserted, results })
}
