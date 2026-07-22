import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export const maxDuration = 300

const FEEDS = [
  {
    url: 'https://gobound.com/co/schools/theclassahs/calendar/ical/f4c41b333289444',
    source: 'https://gobound.com/co/schools/theclassahs/calendar?v=list',
    label: 'TCA Athletics',
    deletePattern: '%gobound%ical%',
  },
  {
    url: 'https://www.tcatitans.org/fs/calendar-manager/events.ics?calendar_ids=8',
    source: 'https://www.tcatitans.org/calendar',
    label: 'TCA School Calendar',
    deletePattern: '%tcatitans.org/calendar%',
  },
]

function isAuthorized(req: NextRequest): boolean {
  if (req.headers.get('x-vercel-cron') === '1') return true
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret === process.env.CRAWL_SECRET) return true
  return req.headers.get('authorization') === `Bearer ${process.env.CRAWL_SECRET}`
}

interface CalEvent {
  summary: string
  start: string
  end: string
  location: string
  activity: string
  level: string
  sex: string
}

function parseIcal(text: string): CalEvent[] {
  const events: CalEvent[] = []
  for (const block of text.split('BEGIN:VEVENT').slice(1)) {
    const get = (key: string) => {
      const m = block.match(new RegExp(`${key}[^:\\r\\n]*:([^\\r\\n]+)`))
      return m?.[1]?.trim() ?? ''
    }
    const startRaw = get('DTSTART')
    if (!startRaw) continue
    events.push({
      summary: get('SUMMARY'),
      start: startRaw,
      end: get('DTEND'),
      location: get('LOCATION'),
      activity: get('X-BND-ACTIVITYNAME'),
      level: get('X-BND-ACTIVITYLEVEL'),
      sex: get('X-BND-ACTIVITYSEX'),
    })
  }
  return events
}

function formatDate(dtstr: string): string {
  const isUtc = dtstr.endsWith('Z')
  const clean = dtstr.replace(/Z$/, '')
  const m = clean.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/)
  if (!m) {
    // All-day: YYYYMMDD — parse as UTC to avoid timezone shifting the date
    const d = clean.match(/(\d{4})(\d{2})(\d{2})/)
    if (!d) return dtstr
    return new Date(`${d[1]}-${d[2]}-${d[3]}T00:00:00Z`).toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    })
  }
  const [, year, month, day, hour, minute] = m
  let date: Date
  if (isUtc) {
    date = new Date(`${year}-${month}-${day}T${hour}:${minute}:00Z`)
  } else {
    // Local Denver time — approximate offset (MDT Apr–Oct = -06:00, MST Nov–Mar = -07:00)
    const mo = parseInt(month)
    const offset = (mo >= 4 && mo <= 10) ? '-06:00' : '-07:00'
    date = new Date(`${year}-${month}-${day}T${hour}:${minute}:00${offset}`)
  }
  if (isNaN(date.getTime())) return dtstr
  return date.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver',
  })
}

function parseDate(dtstr: string): Date {
  const isUtc = dtstr.endsWith('Z')
  const clean = dtstr.replace(/Z$/, '')
  const m = clean.match(/(\d{4})(\d{2})(\d{2})/)
  if (!m) return new Date(0)
  const [, year, month, day] = m
  const t = clean.match(/T(\d{2})(\d{2})/)
  if (!t || isUtc) {
    return new Date(`${year}-${month}-${day}T${t ? t[1] + ':' + t[2] + ':00' : '00:00:00'}Z`)
  }
  const mo = parseInt(month)
  const offset = (mo >= 4 && mo <= 10) ? '-06:00' : '-07:00'
  return new Date(`${year}-${month}-${day}T${t[1]}:${t[2]}:00${offset}`)
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { VoyageAIClient } = await import('voyageai')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()
  const results = []

  for (const feed of FEEDS) {
    const res = await fetch(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TCAHub/1.0)' } })
    if (!res.ok) { results.push({ feed: feed.label, error: res.status }); continue }

    const ical = await res.text()
    const events = parseIcal(ical)

    // Group by activity (athletics) or by month (school calendar)
    const isAthletics = feed.label.includes('Athletics')
    const groups: Record<string, CalEvent[]> = {}

    for (const e of events) {
      let key: string
      if (isAthletics) {
        const sexLabel = e.sex === 'female' ? ' (Girls)' : e.sex === 'male' ? ' (Boys)' : ''
        key = `${e.activity || 'General'}${e.level ? ' ' + e.level : ''}${sexLabel}`
      } else {
        // Group school calendar events by month
        const d = parseDate(e.start)
        key = d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/Denver' })
      }
      if (!groups[key]) groups[key] = []
      groups[key].push(e)
    }

    // Upcoming chunk (next 30 days) for both feeds
    const cutoff = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const upcoming = events
      .filter(e => { const d = parseDate(e.start); return d >= new Date() && d <= cutoff })
      .sort((a, b) => parseDate(a.start).getTime() - parseDate(b.start).getTime())

    // Delete old chunks (both old and new URL formats)
    await supabase.from('page_chunks').delete().ilike('url', feed.deletePattern)
    await supabase.from('page_chunks').delete().ilike('url', feed.source + '%')

    const chunks: Array<{ url: string; title: string; content: string }> = []

    const formatEvent = (e: CalEvent) => {
      // For all-day multi-day events, iCal DTEND is exclusive (the day after last day)
      const startDay = e.start.replace(/T.*/, '')
      let endDay = e.end.replace(/T.*/, '')
      // Subtract one day from exclusive end for all-day events
      if (endDay && !e.end.includes('T') && endDay !== startDay) {
        const d = new Date(endDay.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') + 'T00:00:00Z')
        d.setUTCDate(d.getUTCDate() - 1)
        endDay = d.toISOString().slice(0, 10).replace(/-/g, '')
      }
      const dateStr = (endDay && endDay !== startDay)
        ? `${formatDate(e.start)} – ${formatDate(endDay)}`
        : formatDate(e.start)
      return `  ${dateStr}: ${e.summary}${e.location ? ' @ ' + e.location : ''}`
    }

    if (upcoming.length) {
      const lines = [`${feed.label} — Upcoming Events (next 30 days):`]
      for (const e of upcoming) lines.push(formatEvent(e))
      chunks.push({ url: feed.source + '#upcoming', title: `${feed.label} — Upcoming`, content: lines.join('\n') })
    }

    for (const [groupName, evts] of Object.entries(groups)) {
      evts.sort((a, b) => parseDate(a.start).getTime() - parseDate(b.start).getTime())
      const lines = [`${feed.label} — ${groupName}:`]
      for (const e of evts) lines.push(formatEvent(e))
      chunks.push({
        url: `${feed.source}#${groupName.toLowerCase().replace(/[\s/(),]+/g, '-')}`,
        title: `${feed.label} — ${groupName}`,
        content: lines.join('\n'),
      })
    }

    let inserted = 0
    for (const chunk of chunks) {
      const embRes = await voyage.embed({ input: [chunk.content.slice(0, 16000)], model: 'voyage-3-lite' })
      const embedding = embRes.data?.[0]?.embedding
      if (!embedding) continue
      const { error } = await supabase.from('page_chunks').insert({ ...chunk, embedding, crawled_at: now })
      if (!error) inserted++
    }

    results.push({ feed: feed.label, events: events.length, groups: Object.keys(groups).length, chunksInserted: inserted })
  }

  return NextResponse.json({ results })
}
