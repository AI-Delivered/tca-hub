import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isCrawlAuthorized } from '@/lib/auth'
import { storeChunks } from '@/lib/ingest-chunks'
import { withIngestLog } from '@/lib/ingest-log'
import { zonedInstant } from '@/lib/schedule'

export const maxDuration = 300

// Every feed in this file publishes for one school, in one place.
const TZ = 'America/Denver'

const FEEDS = [
  {
    url: 'https://gobound.com/co/schools/theclassahs/calendar/ical/f4c41b333289444',
    source: 'https://gobound.com/co/schools/theclassahs/calendar?v=list',
    label: 'TCA Athletics',
    deletePattern: '%gobound%ical%',
  },
  /* Finalsite calendar feeds, by the division TCA actually publishes.
   *
   * These were per-campus IDs read off data-calendar-ids attributes, and the
   * school has since retired those calendars. Checked against the live feeds:
   *
   *   High School     -> id 12, which is "Cottage School Program". Twelve
   *                      chunks of another division's dates were sitting in the
   *                      corpus titled "High School Calendar", and the app
   *                      answered high school calendar questions from them.
   *   Central Elem.   -> id 2, whose last event is 2026-05-21. 197 events, none
   *                      upcoming, so the route inserted zero chunks and
   *                      Central Elementary had no calendar in the corpus at
   *                      all. It reported "0 chunks" every six hours and that
   *                      read as nothing to do.
   *
   * Live IDs: 9 Elementary, 10 Secondary, 11 College Pathways, 12 Cottage
   * School, 8 "All TCA" for the closures everyone shares. Campus rows are kept
   * because the label becomes the chunk title and a parent asks by campus, but
   * each now points at its real division. The elementary three genuinely share
   * one calendar, so they hold the same events — worth collapsing, but that is
   * a separate change from making them correct.
   */
  {
    url: 'https://www.tcatitans.org/fs/calendar-manager/events.ics?calendar_ids=9,8',
    source: 'https://www.tcatitans.org/schools/east-elementary/east-elementary-calendar',
    label: 'East Elementary Calendar',
    deletePattern: '%east-elementary-calendar%',
  },
  {
    url: 'https://www.tcatitans.org/fs/calendar-manager/events.ics?calendar_ids=9,8',
    source: 'https://www.tcatitans.org/schools/central-elementary/central-elementary-calendar',
    label: 'Central Elementary Calendar',
    deletePattern: '%central-elementary-calendar%',
  },
  {
    url: 'https://www.tcatitans.org/fs/calendar-manager/events.ics?calendar_ids=9,8',
    source: 'https://www.tcatitans.org/schools/north-elementary/north-elementary-calendar',
    label: 'North Elementary Calendar',
    deletePattern: '%north-elementary-calendar%',
  },
  {
    url: 'https://www.tcatitans.org/fs/calendar-manager/events.ics?calendar_ids=11,8',
    source: 'https://www.tcatitans.org/schools/college-pathways/college-pathways-calendar',
    label: 'College Pathways Calendar',
    deletePattern: '%college-pathways-calendar%',
  },
  /* One Secondary entry, not two, and pointed at a page that exists.
   *
   * /schools/junior-high/junior-high-calendar and
   * /schools/high-school/high-school-calendar both return 404 — the school has
   * no per-campus calendar page for either, and its own secondary homepages
   * link to /calendar instead. Storing 22 chunks under those URLs did two
   * things: every citation under a secondary calendar answer was a dead link,
   * and because the crawler cannot visit a 404 it never saw them, so the stale
   * sweep deleted them on each healthy crawl and this route recreated them six
   * hours later, forever.
   *
   * Junior High and High School read the same Secondary feed, so they are one
   * entry whose title names both — a parent asking about either still matches.
   *
   * The #secondary fragment keeps these rows distinct from the crawler's own
   * chunks for /calendar, which would otherwise share a URL and delete each
   * other. It survives the sweep for the same reason: the crawler compares
   * fragment-stripped URLs, so it never matches this one.
   */
  {
    url: 'https://www.tcatitans.org/fs/calendar-manager/events.ics?calendar_ids=10,8',
    source: 'https://www.tcatitans.org/calendar#secondary',
    label: 'Junior High & High School Calendar',
    deletePattern: '%tcatitans.org/calendar#secondary%',
  },
  {
    url: 'https://www.tcatitans.org/fs/calendar-manager/events.ics?calendar_ids=12,8',
    source: 'https://www.tcatitans.org/schools/cottage-school/cottage-school-calendar',
    label: 'Cottage School Calendar',
    deletePattern: '%cottage-school-calendar%',
  },

  // TeamReach — the coaches' own feeds, and the only source for practice times.
  // These were missing from this list while the rest of the file still carried
  // full TeamReach handling (`isTeamreach`, the Practices/Games/Events
  // grouping): dead code on one side, and on the other, eight chunks left in
  // the database from whenever the feeds were last removed. Nothing refreshed
  // them and nothing deleted them, because the athletics delete pattern is
  // '%gobound%ical%' and these URLs are api.teamreach.net — so the football
  // practice schedule a parent got answered from was a July 23 snapshot whose
  // searchable portion was the 2018 season.
  {
    url: 'https://api.teamreach.net/api/events/teams/20623/ical',
    source: 'https://api.teamreach.net/api/events/teams/20623/ical',
    label: 'TCA HS Football',
    deletePattern: '%teamreach.net/api/events/teams/20623%',
    teamreach: true,
  },
  {
    url: 'https://api.teamreach.net/api/events/teams/161822/ical',
    source: 'https://api.teamreach.net/api/events/teams/161822/ical',
    label: 'TCA JH Football',
    deletePattern: '%teamreach.net/api/events/teams/161822%',
    teamreach: true,
  },
]

interface CalEvent {
  summary: string
  start: string
  end: string
  location: string
  description: string
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
      description: get('DESCRIPTION'),
      activity: get('X-BND-ACTIVITYNAME'),
      level: get('X-BND-ACTIVITYLEVEL'),
      sex: get('X-BND-ACTIVITYSEX'),
    })
  }
  return events
}

/** The Date an iCal timestamp denotes, or null if it is an all-day value. */
function parseIcalTime(dtstr: string): Date | null {
  const isUtc = dtstr.endsWith('Z')
  const clean = dtstr.replace(/Z$/, '')
  const m = clean.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/)
  if (!m) return null
  const [, year, month, day, hour, minute] = m
  if (isUtc) return new Date(`${year}-${month}-${day}T${hour}:${minute}:00Z`)
  // Floating time means Denver wall clock. The offset is asked of the zone rather
  // than guessed from the month — see zonedInstant.
  return zonedInstant(Number(year), Number(month), Number(day), Number(hour), Number(minute), TZ)
}

/** "5:30 PM" — the clock time alone, for the end of a same-day event. */
function formatTimeOnly(dtstr: string): string {
  const d = parseIcalTime(dtstr)
  if (!d || isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ })
}

/* One date format across every source: `YYYY-MM-DD (Ddd) h:mm AM`.
 *
 * This used to emit `Thu, Aug 20, 2026, 6:00 PM`, and two things went wrong.
 *
 * The search route filters context to an asked-about week in code — the fix for
 * a model that resolved "next week" to the wrong seven days — and that filter
 * matches lines beginning `YYYY-MM-DD`. Athletics schedules written in the
 * `Thu, Aug 20` form were invisible to it, so a computed week list built from
 * them was silently short while still being handed over labelled COMPLETE. The
 * ISO prefix is what makes a line eligible for that filter at all.
 *
 * The weekday stays, in parentheses, because the model was deriving it and
 * getting it wrong: asked for the flag football schedule it called Saturday
 * August 15 and Saturday October 10 "Friday". A day name is cheap to write here
 * and it is one less thing computed at answer time.
 */
function formatDate(dtstr: string): string {
  const isUtc = dtstr.endsWith('Z')
  const clean = dtstr.replace(/Z$/, '')
  /* The day is spelled out in full, not abbreviated.
   *
   * `(Thu)` was not enough. Given `2026-08-20 (Thu)` the model still wrote
   * "Saturday, August 20" in one phrasing and "Tuesday, August 20 (Thu)" in
   * another — it expands the abbreviation into prose and expands it wrongly, and
   * a prompt instruction to use the parenthetical as written did not hold. With
   * "Thursday" already in the line there is nothing to expand: the word the
   * answer needs is the word that is there. Five characters per event to remove
   * a class of error that puts a parent at a field on the wrong day. */
  const iso = (d: Date, tz: string) => {
    const ymd = d.toLocaleDateString('en-CA', { timeZone: tz })
    const dow = d.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz })
    return `${ymd} (${dow})`
  }
  const m = clean.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/)
  if (!m) {
    // All-day: YYYYMMDD — parse as UTC to avoid timezone shifting the date
    const d = clean.match(/(\d{4})(\d{2})(\d{2})/)
    if (!d) return dtstr
    return iso(new Date(`${d[1]}-${d[2]}-${d[3]}T00:00:00Z`), 'UTC')
  }
  const [, year, month, day, hour, minute] = m
  const date = isUtc
    ? new Date(`${year}-${month}-${day}T${hour}:${minute}:00Z`)
    : zonedInstant(Number(year), Number(month), Number(day), Number(hour), Number(minute), TZ)
  if (isNaN(date.getTime())) return dtstr
  const time = date.toLocaleString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: TZ,
  })
  return `${iso(date, TZ)} ${time}`
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
  return zonedInstant(Number(year), Number(month), Number(day), Number(t[1]), Number(t[2]), TZ)
}

async function run(req: NextRequest) {
  if (!isCrawlAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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

    // Group by activity (athletics), by month (school calendar), or by event type (teamreach)
    const isAthletics = feed.label.includes('Athletics')
    const isTeamreach = 'teamreach' in feed && feed.teamreach === true
    const groups: Record<string, CalEvent[]> = {}

    const teamreachEventType = (summary: string): string => {
      const s = summary.toLowerCase()
      if (s.includes(' game') || s.includes('vs ')) return 'Games'
      if (s.includes('practice') || s.includes('drills') || s.includes('weights') || s.includes('scrimmage') || s.includes('camp')) return 'Practices & Training'
      return 'Events'
    }

    // Only events worth answering from. The TeamReach feeds carry the team's
    // entire history — "TCA HS Football — Practices & Training" ran to 111,838
    // characters covering June 2018 to August 2026 — and the grouped chunks
    // below used to be built from all of it, unfiltered. Two things went wrong
    // as a result:
    //
    //   1. Only the first 16,000 characters of a chunk were ever embedded, and
    //      the feed is in date order, so the searchable portion of the football
    //      practice schedule was 2018-2019. The current season sat at the end,
    //      findable by nothing.
    //   2. Even fixed, embedding eight years of finished practices just fills
    //      the corpus with events that have already happened.
    //
    // A short backward window keeps "was there practice yesterday" answerable;
    // everything older is history nobody asks about.
    const RECENT_DAYS = 14
    const HORIZON_DAYS = 365
    const windowStart = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000)
    const windowEnd = new Date(Date.now() + HORIZON_DAYS * 24 * 60 * 60 * 1000)
    const relevant = events.filter(e => {
      const d = parseDate(e.start)
      return d >= windowStart && d <= windowEnd
    })

    for (const e of relevant) {
      let key: string
      if (isAthletics) {
        const sexLabel = e.sex === 'female' ? ' (Girls)' : e.sex === 'male' ? ' (Boys)' : ''
        key = `${e.activity || 'General'}${e.level ? ' ' + e.level : ''}${sexLabel}`
      } else if (isTeamreach) {
        key = teamreachEventType(e.summary)
      } else {
        // Group school calendar events by month
        const d = parseDate(e.start)
        key = d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: TZ })
      }
      if (!groups[key]) groups[key] = []
      groups[key].push(e)
    }

    // Upcoming chunk (next 90 days) for all feeds
    const cutoff = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
    const upcoming = events
      .filter(e => { const d = parseDate(e.start); return d >= new Date() && d <= cutoff })
      .sort((a, b) => parseDate(a.start).getTime() - parseDate(b.start).getTime())

    // Delete old chunks (both old and new URL formats)
    await supabase.from('page_chunks').delete().ilike('url', feed.deletePattern)
    await supabase.from('page_chunks').delete().ilike('url', feed.source + '%')

    const chunks: Array<{ url: string; title: string; content: string }> = []

    const formatEvent = (e: CalEvent, includeDescription = false) => {
      // For all-day multi-day events, iCal DTEND is exclusive (the day after last day)
      const startDay = e.start.replace(/T.*/, '')
      let endDay = e.end.replace(/T.*/, '')
      // Subtract one day from exclusive end for all-day events
      if (endDay && !e.end.includes('T') && endDay !== startDay) {
        const d = new Date(endDay.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') + 'T00:00:00Z')
        d.setUTCDate(d.getUTCDate() - 1)
        endDay = d.toISOString().slice(0, 10).replace(/-/g, '')
      }
      /* End times, which this used to throw away.
       *
       * A range was only produced for events spanning more than one day, so a
       * practice — the overwhelmingly common case — showed its start and
       * nothing else: "Tue, Aug 11, 2026, 3:30 PM: Football Practice". A parent
       * arranging a pick-up needs the other end of that.
       *
       * The feed had it all along: 1,466 of TeamReach's 1,606 events carry a
       * DTEND distinct from DTSTART. GoBound's side already showed "5 PM–7 PM",
       * so the two sources disagreed about how complete a practice looked
       * depending on which route ingested it.
       */
      /* Same day, judged in Denver rather than in whatever zone the feed used.
       *
       * TeamReach publishes in UTC, so an evening event routinely ends on the
       * next UTC date: the JV game at Resurrection Christian is
       * DTSTART 20260914T220003Z, DTEND 20260915T000003Z — 4pm to 6pm on one
       * Monday afternoon. Comparing the raw date strings called that a two-day
       * event and rendered it "Mon, Sep 14, 4:00 PM – Tue, Sep 15", which reads
       * as an overnight stay. 358 of the feed's 1,556 timed events cross
       * midnight UTC that way, so it was 23% of them.
       */
      const startAt = parseIcalTime(e.start)
      const endAt = parseIcalTime(e.end)
      const denverDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: TZ })
      const spansDays = startAt && endAt
        ? denverDay(startAt) !== denverDay(endAt)
        : Boolean(endDay && endDay !== startDay)

      const endTime = !spansDays && startAt && endAt ? formatTimeOnly(e.end) : ''
      const dateStr = spansDays
        ? `${formatDate(e.start)} – ${formatDate(endDay)}`
        : endTime && endTime !== formatTimeOnly(e.start)
          ? `${formatDate(e.start)}–${endTime}`
          : formatDate(e.start)
      const desc = includeDescription && e.description
        ? '\n    ' + e.description.replace(/\\n/g, '\n    ').replace(/\\,/g, ',').replace(/\^\^/g, '').trim()
        : ''
      return `  ${dateStr}: ${e.summary}${e.location ? ' @ ' + e.location : ''}${desc}`
    }

    if (upcoming.length) {
      const lines = [`${feed.label} — Upcoming Events (next 30 days):`]
      for (const e of upcoming) {
        if (isAthletics && (e.activity || e.level)) {
          const sexLabel = e.sex === 'female' ? ' (Girls)' : e.sex === 'male' ? ' (Boys)' : ''
          const groupKey = `${e.activity || 'General'}${e.level ? ' ' + e.level : ''}${sexLabel}`
          lines.push(`  [${groupKey}]${formatEvent(e).trimStart() ? ' ' + formatEvent(e).trimStart() : ''}`)
        } else if (isTeamreach) {
          const typeKey = teamreachEventType(e.summary)
          lines.push(`  [${typeKey}]${formatEvent(e, true).trimStart() ? ' ' + formatEvent(e, true).trimStart() : ''}`)
        } else {
          lines.push(formatEvent(e))
        }
      }
      chunks.push({ url: feed.source + '#upcoming', title: `${feed.label} — Upcoming`, content: lines.join('\n') })
    }

    for (const [groupName, evts] of Object.entries(groups)) {
      evts.sort((a, b) => parseDate(a.start).getTime() - parseDate(b.start).getTime())
      const lines = isTeamreach
        ? [`${feed.label} — ${groupName}:`]
        : [`${feed.label} — ${groupName}:`, `(All events below are for ${groupName} only — no other levels):`]
      for (const e of evts) {
        if (isAthletics) {
          lines.push(`  [${groupName}]${formatEvent(e).trimStart() ? ' ' + formatEvent(e).trimStart() : ''}`)
        } else if (isTeamreach) {
          lines.push(formatEvent(e, true))
        } else {
          lines.push(formatEvent(e))
        }
      }
      chunks.push({
        url: `${feed.source}#${groupName.toLowerCase().replace(/[\s/(),]+/g, '-')}`,
        title: `${feed.label} — ${groupName}`,
        content: lines.join('\n'),
      })
    }

    let inserted = 0
    for (const chunk of chunks) {
      // Chunked rather than one row per group, so a long season is searchable
      // all the way through instead of only as far as the first embedding
      // reached — see src/lib/ingest-chunks.ts.
      const stored = await storeChunks(supabase, voyage, chunk, now)
      inserted += stored.inserted
    }

    results.push({
      feed: feed.label,
      events: events.length,
      inWindow: relevant.length,
      groups: Object.keys(groups).length,
      chunksInserted: inserted,
    })
  }

  return NextResponse.json({ results })
}

/** Every invocation is recorded so the dashboard can report what changed. */
function handler(req: NextRequest) {
  return withIngestLog(req, '/api/crawl/ingest-ical', () => run(req))
}

export const GET = handler
