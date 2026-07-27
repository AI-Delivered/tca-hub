import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isCrawlAuthorized } from '@/lib/auth'
import { storeChunks } from '@/lib/ingest-chunks'

export const maxDuration = 300

const BASE = 'https://gobound.com'
const SCHOOL = 'theclassahs'
const CHUNK_URL = `${BASE}/co/schools/${SCHOOL}/calendar`

const PAGES = 3 // ~90 days ahead in 30-day windows

async function fetchCalendarPage(date: string): Promise<string> {
  const url = `${BASE}/co/schools/${SCHOOL}/calendar?includePractices=true&v=list&date=${date}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://gobound.com/',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
    },
  })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.text()
}

interface CalendarEvent {
  date: string
  startDateTime: string
  endDateTime: string
  name: string
  location: string
  cancelled: boolean
  sport: string
}

function formatTime(iso: string): string {
  const [, timePart] = iso.split('T')
  const [h, m] = timePart.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const hour = h % 12 || 12
  return m === 0 ? `${hour} ${ampm}` : `${hour}:${m.toString().padStart(2, '0')} ${ampm}`
}

function parseCalendar(html: string): CalendarEvent[] {
  const seen = new Set<string>()
  const events: CalendarEvent[] = []

  // Events are embedded as JSON in the HTML with this pattern
  const titleRe = /"title":"([^"]+)","caption[^}]+"startDateTime":"([^"]+)","endDateTime":"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = titleRe.exec(html)) !== null) {
    const name = m[1].trim()
    const startDateTime = m[2]
    const endDateTime = m[3]
    const date = startDateTime.slice(0, 10)
    const key = `${date}|${name}|${startDateTime}`
    if (seen.has(key)) continue
    seen.add(key)
    events.push({ date, startDateTime, endDateTime, name, location: '', cancelled: false, sport: '' })
  }

  // Location is in a separate JSON fragment
  const locRe = /"title":"([^"]+)","location":"([^"]*)","venueName[^}]+"startDateTime":"([^"]+)"/g
  const locMap = new Map<string, string>()
  while ((m = locRe.exec(html)) !== null) {
    locMap.set(`${m[3].slice(0, 10)}|${m[1].trim()}|${m[3]}`, m[2])
  }

  // Sport/activity name
  const sportRe = /"actName":"([^"]+)"[^}]+"startDateTime":"([^"]+)"/g
  const sportMap = new Map<string, string>()
  while ((m = sportRe.exec(html)) !== null) {
    const k = `${m[2].slice(0, 10)}|${m[2]}`
    if (!sportMap.has(k)) sportMap.set(k, m[1])
  }

  return events.map(e => ({
    ...e,
    location: locMap.get(`${e.date}|${e.name}|${e.startDateTime}`) ?? '',
    sport: sportMap.get(`${e.date}|${e.startDateTime}`) ?? '',
  }))
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

export async function GET(req: NextRequest) {
  if (!isCrawlAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { VoyageAIClient } = await import('voyageai')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()
  const today = now.slice(0, 10)

  // NB: the delete used to run here, before the fetch below. Any GoBound hiccup
  // then left the athletics schedule wiped — including the "Upcoming Schedule"
  // chunk search/route.ts anchors on — until a later run happened to succeed.
  // Nothing is removed now until replacement events are in hand.

  const pages = await Promise.allSettled(
    Array.from({ length: PAGES }, (_, i) => fetchCalendarPage(addDays(today, i * 30)))
  )

  const allEvents: CalendarEvent[] = []
  for (const page of pages) {
    if (page.status === 'fulfilled') allEvents.push(...parseCalendar(page.value))
  }

  // Deduplicate across pages
  const seen = new Set<string>()
  const events = allEvents.filter(e => {
    const key = `${e.date}|${e.name}|${e.startDateTime}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((a, b) => a.startDateTime.localeCompare(b.startDateTime))

  if (!events.length) {
    // Keep whatever's already stored — stale schedule data beats none at all.
    return NextResponse.json({ chunksInserted: 0, events: 0, note: 'No events parsed — existing chunks left in place' })
  }

  await supabase.from('page_chunks').delete().ilike('url', `${CHUNK_URL}%`)

  let chunksInserted = 0

  // Full upcoming schedule chunk
  const fullLines = [`TCA Athletics & Activities — Upcoming Schedule (as of ${today}):`]
  for (const e of events) {
    const timeStr = `${formatTime(e.startDateTime)}–${formatTime(e.endDateTime)}`
    const sport = e.sport ? ` [${e.sport}]` : ''
    const loc = e.location ? ` @ ${e.location}` : ''
    const cancelled = e.cancelled ? ' [CANCELLED]' : ''
    fullLines.push(`${e.date} ${timeStr} — ${e.name}${sport}${loc}${cancelled}`)
  }

  try {
    // Was truncated to 16,000 characters outright — the whole-schedule chunk
    // physically lost every event past that point. Chunked now, so a full
    // season's athletics calendar survives intact and searchable.
    const stored = await storeChunks(
      supabase,
      voyage,
      {
        url: CHUNK_URL,
        title: 'TCA Athletics & Activities — Upcoming Schedule',
        content: fullLines.join('\n'),
      },
      now
    )
    chunksInserted += stored.inserted
  } catch (e) {
    console.error('Full schedule chunk error:', e)
  }

  // Per-sport chunks for targeted queries
  const groups = new Map<string, CalendarEvent[]>()
  for (const e of events) {
    const key = e.sport || e.name.replace(/^(HS-|JH-)\s*/i, '').replace(/\s*(Off.Season|Practice|Camp|Scrimmage).*/i, '').trim() || 'General'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(e)
  }

  for (const [sport, sportEvents] of groups) {
    const lines = [`TCA ${sport} — Upcoming Events:`]
    for (const e of sportEvents) {
      const timeStr = `${formatTime(e.startDateTime)}–${formatTime(e.endDateTime)}`
      const loc = e.location ? ` @ ${e.location}` : ''
      const cancelled = e.cancelled ? ' [CANCELLED]' : ''
      lines.push(`${e.date} ${timeStr} — ${e.name}${loc}${cancelled}`)
    }
    const content = lines.join('\n')
    const chunkUrl = `${CHUNK_URL}#${sport.toLowerCase().replace(/\s+/g, '-')}`

    try {
      const stored = await storeChunks(
        supabase,
        voyage,
        { url: chunkUrl, title: `TCA ${sport} Schedule`, content },
        now
      )
      chunksInserted += stored.inserted
    } catch { /* continue */ }
  }

  return NextResponse.json({ chunksInserted, events: events.length, sports: groups.size })
}
