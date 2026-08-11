/* Checking the corpus against the rules the code assumes about it.
 *
 * Every defect found in this area had the same shape, and it is worth naming
 * because it says what to automate. A producer and a consumer agreed on a format
 * in a comment; one of them changed; nothing checked. And in every case the
 * counters stayed healthy while the app got quietly worse:
 *
 *   ingest-calendar wrote `4 PM` where the search filters need `4:00 PM`, so most
 *   of that chunk was invisible to a list the model is told is COMPLETE. Insert
 *   count: unchanged.
 *
 *   trimChunk's "drop events already played" filter matched only the old date
 *   format, so after the move to ISO dates it filtered nothing, for months.
 *
 *   ingest-calendar's delete pattern reached ingest-ical's rows, so the good
 *   athletics source was erased and replaced by the worse one every night at
 *   10:00. Both routes reported success, every night, for as long as they existed.
 *
 *   A calendar feed pointed at a division whose last event was months past. The
 *   route inserted zero chunks and reported zero, and zero reads as "nothing to
 *   do" rather than "this campus has no calendar at all".
 *
 * None of that is visible in a unit test, because the functions were each doing
 * what they said. It is visible the moment anything looks at the stored data and
 * asks whether the rules still hold. That is what this does: assertions about the
 * corpus rather than about a function, run on a cron against production, reported
 * where a human already looks.
 *
 * It reports; it never rewrites. A corpus that repairs itself hides the bug that
 * damaged it, and the point of this file is to stop things being hidden.
 */

import {
  DATED_LINE, weekdayFor, longDate, datesIn, datesNamedIn, checkAnswerDates,
} from './schedule.ts'
import { identifiesSchool } from './school-identity.ts'

export interface Finding {
  /** Stable name, so a count can be tracked over time. */
  check: string
  severity: 'error' | 'warn'
  /** One line, in the terms of the thing that is wrong. */
  what: string
  /** The source it was found in. */
  where: string
  /** What to do about it — a finding nobody can act on is noise. */
  action: string
}

export interface AuditReport {
  errors: number
  warnings: number
  /** Every check that fired, and how many times — the count matters more than the examples. */
  counts: Record<string, number>
  /** Up to EXAMPLES_PER_CHECK per check, so one systemic fault cannot bury the rest. */
  findings: Finding[]
  checked: { chunks: number; answers: number; sources: number }
  notes: string[]
}

/* One systemic fault produces thousands of instances of itself.
 *
 * The `4 PM` bug would have reported every event in an eighteen-week schedule.
 * A count of 1,240 with five examples is the same information as 1,240 findings
 * and can actually be read. */
const EXAMPLES_PER_CHECK = 5

export interface Chunk { url: string; title: string; content: string }
export interface LoggedAnswer { query: string; answer: string; created_at?: string }

/** A stored schedule line, pulled apart far enough to check it. */
interface StoredEvent {
  url: string
  line: string
  ymd: string
  /** The day name the line prints in parentheses, or '' if it prints none. */
  printedDay: string
  /** The level tag, so JV at 4:30 and Varsity at 6:00 are not "a conflict". */
  level: string
  time: string
  name: string
}

/* Taken apart in steps rather than by one regex.
 *
 * The one-regex version got the name wrong on every line with a time *range* in
 * it: `6:00 PM–7:30 PM: TCA vs Palmer Ridge` came back as "30 PM: TCA vs Palmer
 * Ridge", because the colon inside the end time ended the field early. Two sources
 * carrying the same fixture then produced different names and the conflict check
 * silently matched nothing — a checker with a parsing bug reports a clean corpus,
 * which is worse than no checker. Both line formats are stripped left to right:
 *
 *   [Volleyball Varsity (Girls)] 2026-08-20 (Thursday) 6:00 PM–7:30 PM: TCA vs X @ Gym
 *   2026-08-28 (Friday) 8:00 AM–10:00 AM — JH Picture Day @ North Campus
 */
function parseStored(url: string, raw: string): StoredEvent | null {
  const line = raw.trim()
  const level = /^\[([^\]]+)\]/.exec(line)?.[1]?.trim() ?? ''
  let tail = line.replace(/^\[[^\]]+\]\s*/, '')

  const date = /^(\d{4}-\d{2}-\d{2})(?:\s*\((\w+)\))?/.exec(tail)
  if (!date) return null
  tail = tail.slice(date[0].length).trimStart()

  const range = /^(\d{1,2}:\d{2}\s*[AP]M)(?:\s*[–—-]\s*\d{1,2}:\d{2}\s*[AP]M)?/i.exec(tail)
  if (range) tail = tail.slice(range[0].length).trimStart()

  return {
    url, line,
    level,
    ymd: date[1],
    printedDay: date[2] ?? '',
    time: range?.[1].replace(/\s+/g, ' ').toUpperCase() ?? '',
    name: tail.replace(/^[:—–-]+\s*/, '').split(' @ ')[0].trim(),
  }
}

/** Event identity for conflict detection: the same fixture, however it is written. */
function eventKey(e: StoredEvent): string {
  const name = e.name.toLowerCase().replace(/^tca\s+/, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
  return `${e.ymd}|${e.level.toLowerCase()}|${name}`
}

export function runAudit(input: {
  chunks: Chunk[]
  answers: LoggedAnswer[]
  today: string
  notes?: string[]
}): AuditReport {
  const { chunks, answers, today } = input
  const found: Finding[] = []
  const counts: Record<string, number> = {}
  const add = (f: Finding) => {
    counts[f.check] = (counts[f.check] ?? 0) + 1
    if (found.filter(x => x.check === f.check).length < EXAMPLES_PER_CHECK) found.push(f)
  }

  const events: StoredEvent[] = []
  const latestBySource = new Map<string, string>()
  const corpusDates = new Set<string>()
  const sources = new Set<string>()

  for (const chunk of chunks) {
    sources.add(chunk.url)
    for (const d of datesIn(chunk.content)) corpusDates.add(d.ymd)

    for (const raw of chunk.content.split('\n')) {
      const line = raw.trim()
      const iso = line.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0]
      if (!iso) continue

      /* An ISO date on a line the event filters cannot see.
       *
       * This is the `4 PM` bug, and the check that would have caught it the
       * morning after it shipped. A line carrying a date and a time that
       * DATED_LINE does not match is an event the "next game" filter and the
       * week list both skip while the list still calls itself complete. */
      const readable = DATED_LINE.test(line)
      const looksLikeSchedule = /\d{1,2}\s*[AP]M|\(\w+day\)/i.test(line)
      if (!readable && looksLikeSchedule) {
        add({
          check: 'dated-line-unreadable', severity: 'error',
          what: `a dated event the search filters cannot see: ${line.slice(0, 90)}`,
          where: chunk.url,
          action: 'the ingest route that wrote this and DATED_LINE disagree on the line format — ' +
            'fix the writer, or widen the rule, then re-ingest',
        })
      }
      if (!readable) continue

      const event = parseStored(chunk.url, line)
      if (!event) continue
      events.push(event)
      const latest = latestBySource.get(chunk.url)
      if (!latest || event.ymd > latest) latestBySource.set(chunk.url, event.ymd)

      /* The day name in a line the app wrote itself.
       *
       * A mismatch here is not the school's typo — it is this code's, and it means
       * a date is being formatted in one timezone and its weekday in another, or
       * an offset is being guessed. That was true for a month of every spring
       * before the offset stopped being guessed from the month. */
      if (event.printedDay && weekdayFor(event.ymd) &&
          event.printedDay.toLowerCase() !== weekdayFor(event.ymd).toLowerCase()) {
        add({
          check: 'weekday-wrong-in-line', severity: 'error',
          what: `stored line says ${event.printedDay}, ${event.ymd} is a ${weekdayFor(event.ymd)}`,
          where: chunk.url,
          action: 'a date/weekday formatting bug in the route that wrote this line — not a source error. ' +
            'Fix and re-ingest; every answer quoting this line is wrong until then',
        })
      }
    }

    /* The school's own text disagreeing with its own date.
     *
     * "JH Picture Day is Thursday, August 28, 2026" — August 28 is a Friday, and
     * nothing in code can tell whether the school meant the Thursday or the 28th.
     * This is the finding that would have answered that question on the day the
     * newsletter was ingested, by naming the source to go and ask. */
    for (const d of datesIn(chunk.content)) {
      if (!d.written) continue
      const actual = weekdayFor(d.ymd)
      if (!actual || new RegExp(`^${actual.slice(0, 3)}`, 'i').test(d.written)) continue
      add({
        check: 'weekday-wrong-in-source', severity: 'warn',
        what: `the source prints "${d.written}" — ${longDate(d.ymd)}`,
        where: chunk.url,
        action: 'the school\'s own text contradicts itself; ask the office which is right. ' +
          'Answers will give the date and flag the disagreement until it is settled',
      })
    }

    /* Text stored as this school's that never names this school.
     *
     * Only for the sources a human pastes in by hand, which is where a wrong-school
     * newsletter can enter: several ASD20 schools publish a "Titan eNews". */
    if (/^(?:email|newsletter):\/\/|smore\.com/.test(chunk.url) && !identifiesSchool(chunk.content).identified) {
      add({
        check: 'unnamed-school', severity: 'warn',
        what: 'stored as TCA content but the text never names the school',
        where: chunk.url,
        action: 'check this is TCA\'s own newsletter and not another Academy District 20 school\'s; ' +
          'delete the rows if it is not',
      })
    }
  }

  /* A calendar whose newest event is in the past.
   *
   * The failure this is for reported success: a feed pointed at a division whose
   * last event was months old inserted zero chunks and said so, and zero reads as
   * "nothing new" rather than "this campus now has no calendar at all". */
  for (const [url, latest] of latestBySource) {
    if (latest >= today) continue
    add({
      check: 'source-stale', severity: 'warn',
      what: `newest event is ${latest}, which is already past`,
      where: url,
      action: 'the feed behind this has stopped producing upcoming events — check the feed URL or ' +
        'calendar id still points where it should',
    })
  }

  /* Two sources, one event, two times.
   *
   * Keyed on the level tag as well as the date and name, so JV at 4:30 and Varsity
   * at 6:00 on the same afternoon are not reported as a disagreement. That also
   * means a conflict between a levelled line and an unlevelled one is not caught —
   * precision first: a wrong finding here costs more than a missed one. */
  const byEvent = new Map<string, StoredEvent[]>()
  for (const e of events) {
    if (!e.name || !e.time) continue
    const key = eventKey(e)
    const group = byEvent.get(key)
    if (group) group.push(e)
    else byEvent.set(key, [e])
  }
  for (const group of byEvent.values()) {
    const times = new Set(group.map(e => e.time))
    const urls = new Set(group.map(e => e.url))
    if (times.size < 2 || urls.size < 2) continue
    add({
      check: 'time-conflict', severity: 'warn',
      what: `${group[0].name} on ${group[0].ymd} is ${[...times].join(' in one source, ')} in another`,
      where: [...urls].join(' vs '),
      action: 'two sources disagree about one event; GoBound wins for games. Answers are told to say ' +
        'both, but a parent should not have to arbitrate — get the wrong one corrected',
    })
  }

  /* What the app actually told parents, checked after the fact.
   *
   * The stream guard makes a day/date contradiction impossible on the way out, so
   * anything found here means the guard is not deployed or not reached — which is
   * worth knowing from the traffic rather than from a parent. */
  for (const row of answers) {
    if (!row.answer?.trim()) continue
    const { corrected, unsupported } = checkAnswerDates(row.answer, { today, contextDates: new Set() })
    for (const bad of [...corrected, ...unsupported].slice(0, 1)) {
      add({
        check: 'answer-day-date-contradiction', severity: 'error',
        what: `answered "${bad.was}" — that date is not that day`,
        where: `query_log: ${row.query.slice(0, 60)}`,
        action: 'the output check did not run on this answer: confirm the deployed build has it and ' +
          'that this path streams through it',
      })
    }

    /* A date in an answer that appears nowhere in the corpus.
     *
     * Not always wrong — a parent asking "what is 6 weeks from Monday" would trip
     * it — but it is the signature of a date the model produced rather than read,
     * which is the one thing no retrieval fix can catch. */
    for (const ymd of datesNamedIn(row.answer, today)) {
      if (corpusDates.has(ymd)) continue
      add({
        check: 'answer-date-not-in-corpus', severity: 'warn',
        what: `answered with ${longDate(ymd)}, which appears in no chunk`,
        where: `query_log: ${row.query.slice(0, 60)}`,
        action: 'either the corpus is missing a source it should have, or the model produced a date ' +
          'rather than reading one — read the answer and its sources',
      })
      break
    }
  }

  const severityOf = (check: string) => found.find(f => f.check === check)?.severity ?? 'warn'
  return {
    errors: Object.entries(counts).filter(([c]) => severityOf(c) === 'error').reduce((n, [, c]) => n + c, 0),
    warnings: Object.entries(counts).filter(([c]) => severityOf(c) === 'warn').reduce((n, [, c]) => n + c, 0),
    counts,
    findings: found,
    checked: { chunks: chunks.length, answers: answers.length, sources: sources.size },
    notes: input.notes ?? [],
  }
}
