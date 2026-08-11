/* Day of the week, worked out from the calendar rather than by the model.
 *
 * Reported answer: "JH Picture Day is Thursday, August 28, 2026." August 28,
 * 2026 is a Friday. The date is the useful half and it was right; the day name
 * was wrong — and that is the worst shape this error takes, because a parent who
 * reads the day and not the number goes looking for the Thursday, which is the
 * 27th, and their child is in front of the camera out of uniform or not at all.
 *
 * ingest-ical met this already and fixed it at the source: it writes
 * `2026-08-20 (Thursday)` into every athletics line so there is nothing left for
 * the model to derive. Nothing else did. The GoBound HTML scrape writes a bare
 * `2026-08-28`, and a newsletter, a school email or a scanned PDF carries
 * whatever prose the school typed. Picture day reaches the corpus through those
 * paths, so its day name was still being computed at answer time — the one thing
 * the ical commit set out to stop.
 *
 * So the pieces ingest-ical kept to itself live here instead, where every
 * schedule source and the answer step can use the same ones: a weekday function
 * that cannot drift by a day, the line format the search route's filters
 * recognise, and the list of dates in a piece of context with the day each
 * actually falls on.
 */

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

/** The day of the week `YYYY-MM-DD` falls on, or '' if that is not a real date.
 *
 * No date string is handed to `new Date` and no timezone is named. `new
 * Date('2026-08-28')` is midnight UTC, so asking for its weekday in Denver
 * returns the day before — that single slip is the whole error this file exists
 * to remove, and it is invisible in any test run in UTC. `Date.UTC` with three
 * numbers never leaves UTC, so the result depends on nothing but the date given.
 * The round-trip check rejects 2026-02-30, which `Date.UTC` would otherwise roll
 * forward to March 2 and report a confident, wrong Thursday for. */
export function weekdayFor(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim())
  if (!m) return ''
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = new Date(Date.UTC(year, month - 1, day))
  if (t.getUTCFullYear() !== year || t.getUTCMonth() !== month - 1 || t.getUTCDate() !== day) return ''
  return WEEKDAYS[t.getUTCDay()]
}

/** `2026-08-28` as `Friday, August 28, 2026`, or '' if it is not a real date. */
export function longDate(ymd: string): string {
  const dow = weekdayFor(ymd)
  if (!dow) return ''
  const [year, month, day] = ymd.trim().split('-')
  return `${dow}, ${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`
}

/* A date plus a time, anywhere in the line, is what makes it an event.
 *
 * Shared, because both of the search route's code filters — the "next game" one
 * and the week list it hands over labelled COMPLETE — are built from the lines
 * this matches, and an ingest route that writes a line it does not match puts
 * that event outside both while the list still calls itself complete. It lived
 * in the search route, which is the one place that could not check the ingest
 * side against it. Requiring the date at the start is what once excluded every
 * ical schedule, since those lead with their level:
 * `[Volleyball Varsity (Girls)] 2026-08-20 (Thursday) 6:00 PM`. */
export const DATED_LINE = /(\d{4}-\d{2}-\d{2})(?=.*\d{1,2}:\d{2})/

/** A clock time as `h:mm AM`, from an ISO timestamp or a bare `HH:MM`.
 *
 * Always `h:mm`, never a bare `4 PM`. GoBound's scrape wrote the short form
 * whenever an event started or ended on the hour — `2026-08-28 4 PM–6 PM — JH
 * Picture Day` — and that line carries no `h:mm`, so `DATED_LINE` did not match
 * it. An event on the hour was therefore missing from the "next game" filter and
 * from the week list asserted to be COMPLETE, and school events are usually on
 * the hour: a parent asking what was on this week got an answer built from the
 * quarter-past ones and a flat "nothing is listed" for the rest. */
export function formatClock(isoOrTime: string): string {
  const time = isoOrTime.includes('T') ? isoOrTime.split('T')[1] : isoOrTime
  const m = /^(\d{1,2}):(\d{2})/.exec(time ?? '')
  if (!m) return ''
  const hour = Number(m[1])
  if (hour > 23) return ''
  return `${hour % 12 || 12}:${m[2]} ${hour >= 12 ? 'PM' : 'AM'}`
}

/** One line of a schedule chunk: `2026-08-28 (Friday) 8:00 AM–10:00 AM — JH Picture Day @ North`.
 *
 * The day name is spelled out in full rather than abbreviated for the reason
 * ingest-ical gives: handed `(Thu)`, the model expanded the abbreviation itself
 * and expanded it wrongly. With the whole word in the line there is nothing to
 * expand — the word the answer needs is the word that is there. */
export function scheduleLine(e: {
  date: string
  startDateTime?: string
  endDateTime?: string
  name: string
  location?: string
  cancelled?: boolean
}): string {
  const dow = weekdayFor(e.date)
  const start = formatClock(e.startDateTime ?? '')
  const end = formatClock(e.endDateTime ?? '')
  const when = [
    e.date,
    dow && `(${dow})`,
    end && end !== start ? `${start}–${end}` : start,
  ].filter(Boolean).join(' ')
  return `${when} — ${e.name}${e.location ? ` @ ${e.location}` : ''}${e.cancelled ? ' [CANCELLED]' : ''}`
}

/* Dates written out in prose, and only those carrying their own year.
 *
 * "Picture Day is August 28" needs a year before it has a weekday at all, and
 * the obvious guess — the school year we are in — is wrong for exactly the
 * sentences most likely to be phrased that way, a last-year PDF or an archived
 * newsletter. Getting the year wrong produces a day name that is wrong in the
 * same quiet way the model's own arithmetic was, so a bare month and day gets no
 * pairing and the prompt tells the model to give the date without a day name. */
const PROSE_DATE =
  /\b(?:(Sun|Mon|Tues?|Wed(?:nes)?|Thur?s?|Fri|Satur?)(?:day)?\.?,?\s+)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi

const MONTH_INDEX = new Map(MONTHS.map((name, i) => [name.slice(0, 3).toLowerCase(), i]))

function ymdOf(month: string, day: string, year: string): string {
  const index = MONTH_INDEX.get(month.slice(0, 3).toLowerCase())
  if (index === undefined) return ''
  return `${year}-${String(index + 1).padStart(2, '0')}-${day.padStart(2, '0')}`
}

/** Every date some text names, in prose or ISO form, earliest first.
 *
 * `prose` are the ones written out in words, which is where a day name has to be
 * supplied because the source may not carry one. `written` is the pair as the
 * text actually printed it, kept so a source that prints its own day name can be
 * checked against the calendar rather than trusted. */
export function datesIn(text: string): Array<{ ymd: string; prose: boolean; written?: string }> {
  const found = new Map<string, { ymd: string; prose: boolean; written?: string }>()

  for (const m of text.matchAll(PROSE_DATE)) {
    const ymd = ymdOf(m[2], m[3], m[4])
    if (!ymd || !weekdayFor(ymd)) continue
    const written = m[1] ? m[0].trim() : undefined
    const prior = found.get(ymd)
    // A mismatched day name is the interesting one, so it wins the slot.
    if (prior?.written && !written) continue
    found.set(ymd, { ymd, prose: true, written })
  }

  for (const m of text.matchAll(/\d{4}-\d{2}-\d{2}/g)) {
    if (!weekdayFor(m[0]) || found.has(m[0])) continue
    found.set(m[0], { ymd: m[0], prose: false })
  }

  return [...found.values()].sort((a, b) => a.ymd.localeCompare(b.ymd))
}

/* Enough dates to answer from, not so many that they crowd out the pages.
 *
 * A season's schedule can name a hundred dates. The prose ones come first
 * because they are the ones whose day name is not already spelled out in the
 * line beside them. */
const MAX_PAIRINGS = 40

/** The day-of-week facts for a piece of retrieved context, or '' if it has no dates.
 *
 * Written as a closed list of pairings rather than as an instruction to be
 * careful. The instruction was tried on the athletics path and did not hold: told
 * to use the weekday as written, the model still put its own day in front of it. */
export function weekdayNote(context: string): string {
  const dates = datesIn(context)
  if (!dates.length) return ''

  const ordered = [...dates].sort((a, b) => Number(b.prose) - Number(a.prose))
  const pairings = ordered.slice(0, MAX_PAIRINGS)
    .sort((a, b) => a.ymd.localeCompare(b.ymd))
    .map(d => `${d.ymd} = ${longDate(d.ymd)}`)

  /* Where the school's own text disagrees with its own date.
   *
   * The date and the day name in "Thursday, August 28, 2026" cannot both be
   * right, and nothing here can tell which one the school meant — the event is
   * either on the Thursday, which is the 27th, or on the 28th, which is a Friday.
   * Picking one silently is how a parent ends up at the wrong day with an answer
   * that sounded certain, so the disagreement is handed over to be said out loud
   * along with the page it came from. */
  const conflicts = dates
    .filter(d => d.written && !new RegExp(`^${weekdayFor(d.ymd).slice(0, 3)}`, 'i').test(d.written))
    .slice(0, 3)
    .map(d => `- The context prints "${d.written}". That date is a ${weekdayFor(d.ymd)}. ` +
      `Give the date, say the school's own text prints the other day, and link the page it came from so ` +
      `they can confirm — do not quietly pick one of the two.`)

  return `Day of the week for the dates in your context, computed from the calendar:\n` +
    `${pairings.join('\n')}\n` +
    `Use these pairings exactly. Never work a day of the week out yourself — it is the error this app has ` +
    `made most often, and a wrong day name sends a family to school on the wrong morning. If a date is not ` +
    `listed above and the schedule line does not spell its day out in parentheses, give the date with no day ` +
    `name at all.${conflicts.length ? `\n${conflicts.join('\n')}` : ''}`
}
