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

/* The instant a wall-clock time in a named zone actually denotes.
 *
 * Every route that reads a calendar feed had its own copy of this guess:
 *
 *   const offset = (mo >= 4 && mo <= 10) ? '-06:00' : '-07:00'
 *
 * Colorado does not change its clocks on the first of April and the first of
 * November. In 2026 it springs forward on 8 March and falls back on 1 November,
 * so the guess is an hour wrong for every floating-time event from 8 to 31 March
 * and on 1 November — a whole month of the spring season, in which basketball,
 * track, soccer and lacrosse all play. The event was read an hour earlier than it
 * is and then printed an hour later than it is: `20260315T153000` came out as
 * 4:30 PM. That is the failure this corpus can least afford, because nobody
 * checks a plausible time — they drive to it. An event late enough in the evening
 * crossed midnight in the wrong direction and moved a day as well.
 *
 * The zone itself is asked instead of guessed. Format the guessed instant in the
 * zone, read back what wall clock it lands on, and the difference is the offset in
 * force there; do it twice, because correcting by the first offset can cross a
 * transition and change which offset applies. A wall-clock time that a spring
 * forward skips entirely resolves to the hour before it, which is arbitrary but
 * deterministic — the feed should not be publishing one.
 */
const ZONE_FORMATTERS = new Map<string, Intl.DateTimeFormat>()

function zoneFormatter(tz: string): Intl.DateTimeFormat {
  let formatter = ZONE_FORMATTERS.get(tz)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    ZONE_FORMATTERS.set(tz, formatter)
  }
  return formatter
}

/** The zone's offset from UTC in minutes at a given instant (Denver: -360 or -420). */
export function zoneOffsetMinutes(utcMs: number, tz: string): number {
  const parts = zoneFormatter(tz).formatToParts(new Date(utcMs))
  const value = (type: string) => Number(parts.find(p => p.type === type)?.value)
  // Some ICU versions render midnight as hour 24 under hour12:false.
  const wall = Date.UTC(
    value('year'), value('month') - 1, value('day'),
    value('hour') % 24, value('minute'), value('second')
  )
  return (wall - utcMs) / 60_000
}

/** The instant at which it is `h:min` on `y-mo-d` in `tz`. */
export function zonedInstant(
  y: number, mo: number, d: number, h: number, min: number, tz: string
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, min)
  const first = zoneOffsetMinutes(guess, tz)
  const corrected = guess - first * 60_000
  const second = zoneOffsetMinutes(corrected, tz)
  return new Date(first === second ? corrected : guess - second * 60_000)
}

/** `2026-08-28` as `Friday, August 28, 2026`, or '' if it is not a real date. */
export function longDate(ymd: string): string {
  const dow = weekdayFor(ymd)
  if (!dow) return ''
  const [year, month, day] = ymd.trim().split('-')
  return `${dow}, ${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`
}

/* What makes a line an event: an ISO date, followed either by the day name every
 * ingest route writes or by a clock time somewhere later on.
 *
 * Shared, because both of the search route's code filters — the "next game" one
 * and the week list it hands over labelled COMPLETE — are built from the lines
 * this matches, and an ingest route that writes a line it does not match puts
 * that event outside both while the list still calls itself complete. It lived
 * in the search route, which is the one place that could not check the ingest
 * side against it. Requiring the date at the *start* is what once excluded every
 * ical schedule, since those lead with their level:
 * `[Volleyball Varsity (Girls)] 2026-08-20 (Thursday) 6:00 PM`.
 *
 * The day-name branch is what admits all-day events. A time alone was the whole
 * test, and an all-day entry has no time — so `2026-11-24 (Tuesday) — No School`
 * and an all-day tournament were both invisible: absent from a week list the model
 * is told is COMPLETE and told to answer only from, which turns "is there school
 * on the 24th" into a confident wrong answer, and absent from the next-game filter,
 * where an all-day invitational is a legitimate next fixture.
 *
 * The time requirement was there to keep prose that merely mentions a date out of
 * a list asserted to be exhaustive, and that still holds: prose writes "November
 * 24", not `2026-11-24 (Tuesday)`. The parenthesised day name only appears on a
 * line some ingest route formatted. */
export const DATED_LINE =
  /(\d{4}-\d{2}-\d{2})(?=\s*\((?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\)|.*\d{1,2}:\d{2})/

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

/* Checking the answer itself, on the way out, before a parent can read it.
 *
 * Everything above this line makes a wrong day name less likely: the day is
 * written into the schedule line at ingest, the pairings are computed and handed
 * over, and the prompt says not to derive one. None of that is a guarantee, and a
 * day that contradicts its own date is the specific thing that makes an answer
 * read as untrustworthy — "Thursday, August 28, 2026" is self-evidently broken to
 * anyone holding a calendar, whichever half is wrong. A parent who spots one stops
 * believing the times too.
 *
 * So the last word belongs to code. Every "Thursday, August 28" in an answer is
 * checked against the calendar, and what happens next depends on whether the date
 * is one the retrieved context actually contained:
 *
 *   The date is in the context — the date is real and came from the data, so the
 *   day name is the half that is wrong, and it is corrected to the day that date
 *   falls on.
 *
 *   The date is not in the context — nothing here knows whether the model meant
 *   the 27th or the 28th, so nothing is asserted: the day name comes off and the
 *   date stands alone. Correcting the day name here would turn a visibly broken
 *   answer into a plausible wrong one, which is worse, and the pair is reported so
 *   it stops being invisible.
 *
 * This runs mid-stream, so the check has to be safe on a partial answer. That is
 * what `heldBackFrom` is for: text is only released up to the point where a date
 * phrase could still be forming.
 */
const ANSWER_DATE = new RegExp(
  String.raw`\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b(,?\s+)` +
  String.raw`(January|February|March|April|May|June|July|August|September|October|November|December` +
  String.raw`|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?` +
  String.raw`(?:(,?\s+)(20\d{2}))?`,
  'gi'
)

/** How far back a date phrase can reach: `Wednesday, September 28th, 2026` and a little slack. */
const MAX_PHRASE_CHARS = 40

/** Any text that could still grow into a date phrase, so it is not released yet.
 *
 * Returns the index to stop at, or the length of the text when all of it is safe
 * to send. Only the last candidate can be incomplete — anything earlier has
 * whatever follows it already in hand. */
export function heldBackFrom(text: string): number {
  // Enough of a day name to be recognisable, anywhere in the tail — this is the
  // one that keeps a whole `Thursday, August 28` together while the date arrives.
  let last = -1
  for (const m of text.matchAll(/\b(?:sun|mon|tues?|wed(?:nes)?|thur?s?|fri|satur?)/gi)) last = m.index
  if (last >= 0 && text.length - last < MAX_PHRASE_CHARS) return last

  /* Or as little as a single letter, when the text ends mid-word.
   *
   * Found by running this over every chunk boundary rather than the convenient
   * one. A model streams `JH Picture Day is **T` and then `hursday` — and `T`
   * alone is not recognisable as the start of anything, so it went out, and the
   * `hursday` that followed had nothing in front of it to match. The phrase was
   * checked in two halves, which is to say not checked, and "Thursday, August 28"
   * reached the browser on roughly a third of the chunk widths tried. */
  const tail = /\b([A-Za-z]+)$/.exec(text)
  const partial = tail?.[1].toLowerCase() ?? ''
  if (partial && WEEKDAYS.some(day => day.toLowerCase().startsWith(partial))) return tail!.index
  return text.length
}

export interface DateCheck {
  /** The answer text, with contradictions resolved. */
  text: string
  /** Day names corrected because the date behind them was real. */
  corrected: Array<{ was: string; now: string }>
  /** Pairs whose date the context did not contain — the day name was dropped. */
  unsupported: Array<{ was: string; now: string }>
}

/** Which year a bare "August 28" means, preferring a year the context actually has. */
function resolveYear(month: number, day: number, today: string, contextDates: Set<string>): number {
  const ymd = (y: number) => `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const thisYear = Number(today.slice(0, 4))
  const candidates = [thisYear, thisYear + 1, thisYear - 1]
  const known = candidates.filter(y => contextDates.has(ymd(y)))
  if (known.length === 1) return known[0]
  // Nothing in the context to go on: the nearest occurrence to today, which is how
  // a parent reads an undated "August 28" in a newsletter.
  const todayMs = Date.parse(`${today}T00:00:00Z`)
  return (known.length ? known : candidates)
    .reduce((best, y) =>
      Math.abs(Date.parse(`${ymd(y)}T00:00:00Z`) - todayMs) < Math.abs(Date.parse(`${ymd(best)}T00:00:00Z`) - todayMs)
        ? y : best)
}

const MONTH_INDEX_LONG = new Map(MONTHS.map((name, i) => [name.slice(0, 3).toLowerCase(), i]))

/* Every date an answer names, resolved — including the ones with no year on them.
 *
 * `datesIn` deliberately ignores a bare "August 20", because in *source* text the
 * year is a guess and guessing it wrongly invents a weekday. In an answer the
 * calculation is different: the answer is about now, and the reason to read its
 * dates is to compare two runs of the same question. "August 20" one run and
 * "September 1" the next is the failure that started this — and it is invisible to
 * an extractor that skips both of them.
 *
 * Used by scripts/check-answers.mjs to assert an answer says the same thing twice.
 */
export function datesNamedIn(text: string, today: string): string[] {
  const found = new Set(datesIn(text).map(d => d.ymd))
  for (const m of text.matchAll(ANSWER_DATE)) {
    const monthIndex = MONTH_INDEX_LONG.get(String(m[3]).slice(0, 3).toLowerCase())
    if (monthIndex === undefined) continue
    const year = m[6] ? Number(m[6]) : resolveYear(monthIndex + 1, Number(m[4]), today, found)
    const ymd = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(Number(m[4])).padStart(2, '0')}`
    if (weekdayFor(ymd)) found.add(ymd)
  }
  return [...found].sort()
}

/** Resolve every day/date pair in an answer against the calendar. */
export function checkAnswerDates(
  text: string,
  opts: { today: string; contextDates: Set<string> }
): DateCheck {
  const corrected: Array<{ was: string; now: string }> = []
  const unsupported: Array<{ was: string; now: string }> = []

  const fixed = text.replace(ANSWER_DATE, (match, dow, gap, month, day, yearGap, year) => {
    const monthIndex = MONTH_INDEX_LONG.get(String(month).slice(0, 3).toLowerCase())
    if (monthIndex === undefined) return match
    const resolvedYear = year
      ? Number(year)
      : resolveYear(monthIndex + 1, Number(day), opts.today, opts.contextDates)
    const ymd = `${resolvedYear}-${String(monthIndex + 1).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`
    const actual = weekdayFor(ymd)
    // Not a real date at all (February 30) — leave the text alone rather than
    // rewrite around a date nothing can check.
    if (!actual) return match
    if (actual.toLowerCase() === String(dow).toLowerCase()) return match

    // Everything after the day name, kept exactly as the model wrote it.
    const rest = match.slice(String(dow).length + String(gap).length)
    if (opts.contextDates.has(ymd)) {
      const now = `${actual}${gap}${rest}`
      corrected.push({ was: match, now })
      return now
    }
    unsupported.push({ was: match, now: rest })
    return rest
  })

  return { text: fixed, corrected, unsupported }
}

/* Answering "when is the next game" from the whole schedule instead of a slice of it.
 *
 * Reported: the same question, asked twice, named two different games — Varsity
 * volleyball against Palmer Ridge on 20 August, and against Lewis-Palmer on
 * 1 September. Only the first is the next one. Both answers were written from a
 * context that honestly did not contain the other, which is why re-asking
 * produced a different confident answer rather than a hedge.
 *
 * The cause is in how a long document is stored and then fetched back. storeChunks
 * splits a document into 1,800-character pieces and writes each as its own row
 * under the same url and title, so GoBound's eighteen-week schedule is twenty-odd
 * rows that are all called "TCA Athletics & Activities — Upcoming Schedule". The
 * search route anchored that title with `.limit(1)` and no ordering, so Postgres
 * returned whichever piece it liked: one arbitrary window of the season, changing
 * whenever the nightly ingest deletes and re-inserts the rows. Draw the piece that
 * starts in September and the 20 August match is not merely ranked low, it is
 * absent — and the route's own comment already knew this was the shape of the
 * problem: "the sorting is sound, the input is not always complete."
 *
 * So the pieces are put back together in id order — insertion order, which is
 * document order — and the answer to "the next one" is taken in code from the
 * complete list. Ordering, assembling and picking are all deterministic, so the
 * same corpus and the same question give the same answer every time.
 */
/** One row of `page_chunks`: a piece of a document, not a document. */
export interface Piece {
  id: number
  url: string
  title: string
  content: string
}

/* Overlap is what makes this a join rather than a concatenation.
 *
 * chunkText re-opens each piece with the last whole lines of the one before it,
 * so pasting pieces together plainly repeats those lines — and a repeated event
 * line is a second game to anything counting them. The seam is exact whole lines,
 * so it can be found and dropped exactly. */
const MAX_SEAM_LINES = 40

/** The pieces of one document, joined back into the document, in id order. */
export function assemblePieces(pieces: Piece[]): string {
  const ordered = [...pieces].sort((a, b) => a.id - b.id)
  const out: string[] = []
  for (const piece of ordered) {
    const lines = piece.content.split('\n')
    // Longest run of leading lines that is already the tail of what we have.
    let seam = 0
    for (let n = Math.min(MAX_SEAM_LINES, lines.length, out.length); n > 0; n--) {
      let same = true
      for (let i = 0; i < n; i++) {
        if (out[out.length - n + i] !== lines[i]) { same = false; break }
      }
      if (same) { seam = n; break }
    }
    out.push(...lines.slice(seam))
  }
  return out.join('\n')
}

/** Pieces grouped into documents by url, each assembled, keyed by url. */
export function assembleByUrl(pieces: Piece[]): Array<{ url: string; title: string; content: string }> {
  const groups = new Map<string, Piece[]>()
  for (const piece of pieces) {
    const group = groups.get(piece.url)
    if (group) group.push(piece)
    else groups.set(piece.url, [piece])
  }
  // Documents in the order their first piece was written, so the assembled list
  // is as stable as the rows themselves.
  return [...groups.values()]
    .sort((a, b) => Math.min(...a.map(p => p.id)) - Math.min(...b.map(p => p.id)))
    .map(group => ({
      url: group[0].url,
      title: group[0].title,
      content: assemblePieces(group),
    }))
}

export interface DatedLine {
  /** The event date, `YYYY-MM-DD`. */
  ymd: string
  /** The level tag ingest-ical writes, e.g. `Volleyball Varsity (Girls)`, or ''. */
  level: string
  /** Minutes past midnight, for ordering events within a day. */
  minutes: number
  line: string
}

const LEVEL_TAG = /^\[([^\]]+)\]\s*/
const CLOCK = /(\d{1,2}):(\d{2})\s*(AM|PM)/i

function minutesOf(line: string): number {
  const m = CLOCK.exec(line)
  if (!m) return 0
  const hour = Number(m[1]) % 12 + (m[3].toUpperCase() === 'PM' ? 12 : 0)
  return hour * 60 + Number(m[2])
}

/** Every dated event line in some schedule text, deduplicated and in time order.
 *
 * Deduplicated on the text of the line: the same event legitimately appears in
 * more than one document — GoBound's aggregate view and the per-level schedule
 * both carry it — and two identical lines are one game. */
export function datedLines(text: string): DatedLine[] {
  const seen = new Set<string>()
  const out: DatedLine[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const ymd = line.match(DATED_LINE)?.[1]
    if (!ymd || seen.has(line)) continue
    seen.add(line)
    out.push({
      ymd,
      level: line.match(LEVEL_TAG)?.[1]?.trim() ?? '',
      minutes: minutesOf(line),
      line,
    })
  }
  return out.sort((a, b) =>
    a.ymd.localeCompare(b.ymd) || a.minutes - b.minutes || a.level.localeCompare(b.level) || a.line.localeCompare(b.line))
}

/* What the two kinds of question are asking for.
 *
 * These moved out of the search route so the same test can hold them against the
 * lines an ingest route actually writes. `camp` is anchored for the reason the
 * route recorded: unanchored, it matches "The Classical Academy North Campus",
 * where most home fixtures are played, so every home game read as a practice and
 * was dropped from the answer. */
const IS_PRACTICE = /\b(practice|tryouts?|scrimmage|weights|open gym|camps?|conditioning)\b/i
const IS_GAME = / vs /i

/* Competitions that are not against one named opponent.
 *
 * " vs " was the entire test for a game, and half of TCA's sports do not play
 * that way: a cross country meet, a track invitational, a swim triangular and a
 * wrestling tournament are all one line naming an event and no opponent. So
 * "when is the next cross country meet" could not be computed at all — no line
 * counted as a game, and the question fell back to whatever retrieval returned,
 * which is the behaviour this whole exercise is about.
 *
 * "Meet" needs the guard. A school calendar is full of Meet the Teacher, Meet
 * and Greet and Meet Your Coaches, and calling those a competition would offer a
 * parent an evening in a classroom as their child's next race. */
const IS_COMPETITION =
  /\b(?:invitational|tournaments?|championships?|playoffs?|regionals?|relays?|jamboree|duals?|triangular|quad)\b|\bmeets?\b(?!\s+(?:and|the|&|your|our|with))/i

export function isPractice(line: string): boolean {
  return IS_PRACTICE.test(line)
}

export function isGame(line: string): boolean {
  return (IS_GAME.test(line) || IS_COMPETITION.test(line)) && !IS_PRACTICE.test(line)
}

export interface NextEvent {
  level: string
  ymd: string
  /** Every event for that level on that date — a parent with a player on the
   * other team playing the same afternoon needs their time too. */
  lines: string[]
}

/** The earliest upcoming event of one kind, per level, from a complete list.
 *
 * Per level rather than one overall, because "volleyball" is not one team: JV and
 * Varsity often play the same afternoon, and naming only whichever happens to be
 * first sends half the parents who asked to the wrong place. A line with no level
 * tag has no team to be the next event for, so it is grouped on its own rather
 * than allowed to stand in for one. */
export function nextEventsByLevel(
  lines: DatedLine[],
  opts: { today: string; kind: 'game' | 'practice' }
): NextEvent[] {
  const wanted = opts.kind === 'practice' ? isPractice : isGame
  const earliest = new Map<string, string>()
  for (const l of lines) {
    if (l.ymd < opts.today || !wanted(l.line)) continue
    const prev = earliest.get(l.level)
    if (!prev || l.ymd < prev) earliest.set(l.level, l.ymd)
  }

  return [...earliest.entries()]
    .map(([level, ymd]) => ({
      level,
      ymd,
      lines: lines.filter(l => l.level === level && l.ymd === ymd && wanted(l.line)).map(l => l.line),
    }))
    .sort((a, b) => a.ymd.localeCompare(b.ymd) || a.level.localeCompare(b.level))
}

/* Reading a team out of a question, against the tags the feed itself writes.
 *
 * `ask` is what the parent might type, `tag` is what X-BND-ACTIVITYLEVEL looks
 * like once ingest-ical has written it into the line. Two things need care.
 *
 * "Junior varsity" contains "varsity", so a bare varsity rule matches it and a
 * question about JV would be answered with Varsity's fixture alongside — hence
 * `beats`: the more specific reading of the question wins and removes the looser
 * one. And the levels a parent names are one category while girls/boys is
 * another, so "girls varsity" has to mean Varsity *and* Girls. Within a category
 * the readings are alternatives; across categories they all have to hold, or
 * naming both narrows nothing.
 */
const TEAM_RULES: Array<{ name: string; group: string; ask: RegExp; tag: RegExp; beats?: string[] }> = [
  { name: 'jv', group: 'level', ask: /\b(jv|junior varsity)\b/i, tag: /\bjv\b|junior varsity/i, beats: ['varsity'] },
  { name: 'varsity', group: 'level', ask: /\bvarsity\b/i, tag: /\bvarsity\b/i },
  { name: 'c-squad', group: 'level', ask: /\bc[-\s]?squad\b/i, tag: /\bc[-\s]?squad\b/i },
  { name: 'freshman', group: 'level', ask: /\b(freshman|frosh)\b/i, tag: /\bfreshm[ae]n\b/i },
  { name: 'jh', group: 'level', ask: /\b(jh|junior high|middle school)\b/i, tag: /\bjh\b|junior high/i },
  // "the JH A team" — the tag spells it `Volleyball JH A (Girls)`, so the letter
  // stands alone in it rather than carrying the word "team".
  { name: 'a-team', group: 'squad', ask: /\ba[-\s]team\b/i, tag: /\ba\b/i },
  { name: 'b-team', group: 'squad', ask: /\bb[-\s]team\b/i, tag: /\bb\b/i },
  { name: 'girls', group: 'sex', ask: /\b(girls?|womens?)\b/i, tag: /\(girls\)/i },
  { name: 'boys', group: 'sex', ask: /\b(boys?|mens?)\b/i, tag: /\(boys\)/i },
]

/** The level tags matching the team the parent named, or [] if they named none.
 *
 * [] is not "no teams" but "they did not say" — the caller then answers for every
 * level of the sport and lets the earliest one lead. */
export function levelsAskedFor(query: string, levels: string[]): string[] {
  let asked = TEAM_RULES.filter(r => r.ask.test(query))
  const beaten = new Set(asked.flatMap(r => r.beats ?? []))
  asked = asked.filter(r => !beaten.has(r.name))
  if (!asked.length) return []

  const groups = [...new Set(asked.map(r => r.group))]
  return levels.filter(level =>
    groups.every(group => asked.some(r => r.group === group && r.tag.test(level))))
}
