import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isCrawlAuthorized } from '@/lib/auth'
import { storeChunks } from '@/lib/ingest-chunks'
import { withIngestLog } from '@/lib/ingest-log'
import { scheduleLine } from '@/lib/schedule'

export const maxDuration = 300

const BASE = 'https://gobound.com'
const SCHOOL = 'theclassahs'
const CHUNK_URL = `${BASE}/co/schools/${SCHOOL}/calendar`

/* GoBound's list view returns roughly the next ten days of events from the
 * date it is given, not thirty. This fetched three pages stepped a month apart
 * and assumed each covered the gap, so it captured three narrow windows and
 * dropped everything between them — about two thirds of the calendar.
 *
 * Measured against the live source: the page dated 2026-07-31 ends at 08-10,
 * the one dated 08-30 ends at 09-04, the one dated 09-29 ends at 10-08. The
 * Homecoming Dance on 09-26 fell in a gap and was in none of them, while the
 * page dated 09-20 has it. That is why "when is homecoming" stopped answering
 * even though GoBound had it all along.
 *
 * Stepping by a week with overlapping windows covers the same horizon without
 * gaps. Events are deduplicated below, so the overlap costs nothing but a few
 * parallel fetches.
 */
const PAGE_STEP_DAYS = 7
const PAGES = 18 // ~18 weeks ahead, in overlapping ~10-day windows

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

/* Times and day names are formatted by src/lib/schedule.ts now, which is
 * also where the search route's DATED_LINE lives, so a line written here and the
 * filters that read it cannot drift apart. This route used to have its own
 * formatter, and it differed from every other source in two ways that mattered:
 *
 *   It wrote no day of the week. ingest-ical spells one out on every line
 *   precisely because the model derives them wrongly, and this route feeds the
 *   "TCA Athletics & Activities — Upcoming Schedule" chunk that the search route
 *   pins at 0.90 for calendar questions — which is how "JH Picture Day" came back
 *   as a Thursday when 2026-08-28 is a Friday.
 *
 *   It wrote `4 PM` rather than `4:00 PM` on the hour, and DATED_LINE needs an
 *   `h:mm` after the date to count a line as an event at all. Most school events
 *   start on the hour, so most of this chunk was invisible to both the "next
 *   game" filter and the week list handed over labelled COMPLETE.
 */

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

async function run(req: NextRequest) {
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
    Array.from({ length: PAGES }, (_, i) => fetchCalendarPage(addDays(today, i * PAGE_STEP_DAYS)))
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

  /* Delete this route's own rows, and nothing else.
   *
   * This was `ilike(url, CHUNK_URL + '%')`, and that trailing wildcard reached
   * a great deal further than intended. ingest-ical stores the GoBound iCal
   * feed under `…/calendar?v=list#<sport>` — which begins with CHUNK_URL — so
   * this line deleted it. The crons made that a daily cycle: ingest-ical wrote
   * 230 correct athletics chunks at 09:00, and at 10:00 this route erased every
   * one of them and replaced them with the HTML scrape below. Athletics
   * questions had been answered from the worse of the two sources for as long
   * as both crons existed, and nothing reported it, because this route's own
   * insert count looked healthy either way.
   *
   * Anchored on `#` (this route's per-sport keys) plus the bare URL (its
   * whole-schedule chunk), so a sibling route's query string can no longer be
   * caught by it. */
  await supabase.from('page_chunks').delete().eq('url', CHUNK_URL)
  await supabase.from('page_chunks').delete().ilike('url', `${CHUNK_URL}#%`)

  let chunksInserted = 0
  const storeErrors = 0

  /* The sport label is gone, and so are the per-sport chunks below it.
   *
   * `e.sport` came from joining a separate `actName` regex pass back onto events
   * by `date|startDateTime`, keeping the first match for each key. Two sports at
   * the same date and time therefore shared one label, and the loser inherited
   * the winner's sport. October 8 has four games at 4 PM across four sports and
   * August 22 has two at 10 AM, so the corpus ended up asserting that TCA played
   * Ponderosa, Douglas County and Chinook Trail Middle School at girls flag
   * football, and filed the real games it displaced under other sports. Asked
   * for the flag football schedule, the app named 14 dates' worth of season as
   * six real games plus four fictional ones.
   *
   * That join cannot be repaired by tightening the regex: once the passes are
   * separate, the timestamp is all there is to match on, and it is not unique.
   * The fix is to stop guessing — GoBound's iCal feed carries
   * X-BND-ACTIVITYNAME and X-BND-ACTIVITYLEVEL on every event (checked: 99 flag
   * football events, 99 correct tags, zero disagreement with the summary), and
   * ingest-ical already groups on those. This route keeps the one thing it does
   * that the feed path does not — a single flat everything-upcoming view — and
   * leaves per-sport schedules to the source that knows the sport.
   */
  const fullLines = [`TCA Athletics & Activities — Upcoming Schedule (as of ${today}):`]
  for (const e of events) fullLines.push(scheduleLine(e))

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

  /* Per-sport chunks used to be built here, keyed on the unreliable `e.sport`
   * described above (and, where that was empty, on the event name with
   * "Practice"/"Camp"/"Scrimmage" stripped — which is how a picture day and a
   * homecoming dance each became a "sport" with its own schedule document).
   * ingest-ical builds these from the feed's own activity and level tags
   * instead. Removed rather than left behind a flag, because two sources
   * disagreeing about who TCA plays is worse than one source being incomplete,
   * and the stale rows are cleared by the anchored delete above. */

  return NextResponse.json({
    chunksInserted,
    events: events.length,
    // `sports` and `failedSports` are gone with the per-sport chunks. Reported
    // as a note so a dashboard row that suddenly counts one chunk family
    // instead of ninety-eight reads as intentional rather than as breakage.
    note: 'per-sport schedules now come from ingest-ical (feed activity tags)',
    storeErrors,
  })
}

/** Every invocation is recorded so the dashboard can report what changed. */
function handler(req: NextRequest) {
  return withIngestLog(req, '/api/crawl/ingest-calendar', () => run(req))
}

export const GET = handler
