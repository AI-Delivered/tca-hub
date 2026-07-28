import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isCrawlAuthorized } from '@/lib/auth'
import { storeChunks, sanitizeForPostgres } from '@/lib/ingest-chunks'

export const maxDuration = 300

/* Weekly per-campus announcements ("newsletters").
 *
 * Published Friday or Sunday once the school year is running, one per campus,
 * and each week's replaces the last — nobody asks what last week's newsletter
 * said. That single fact is what makes this route safe to run forever: 18
 * newsletters a week would be ~700 rows a year if they accumulated, which would
 * swamp a 1,700-chunk corpus and bury the calendars and supply lists under a
 * year of stale weekly chatter.
 *
 * Supersession falls out of the URL key. Chunks are stored under
 * `newsletter://<campus>` (plus `/<grade>` when a grade-specific document is
 * found), and each run deletes that campus's whole key range before writing.
 * Steady state is one set of chunks per campus, permanently current, with no
 * date arithmetic and nothing to prune later. Same delete-then-reinsert shape
 * ingest-rosters and ingest-stats already use.
 *
 * The synthetic `newsletter://` scheme is deliberate: it makes the key range
 * trivially deletable and keeps these rows from colliding with the crawled
 * https:// copy of the same page.
 */

interface Campus {
  name: string
  /** Slugs to try in order — the site spells this both ways. */
  paths: string[]
}

// TCA spells the same page two different ways ("weekly-annoucements" on North
// Elementary, "weekly-announcements" on Cottage School), so every campus tries
// both rather than encoding the current typo per campus and breaking when it
// is fixed. Central and East 404 on both today; they are listed because the
// pages are expected to appear when the year starts, and a 404 is skipped
// quietly rather than treated as an error.
const CAMPUSES: Campus[] = [
  { name: 'North Elementary', paths: ['/schools/north-elementary/weekly-annoucements', '/schools/north-elementary/weekly-announcements'] },
  { name: 'Central Elementary', paths: ['/schools/central-elementary/weekly-annoucements', '/schools/central-elementary/weekly-announcements'] },
  { name: 'East Elementary', paths: ['/schools/east-elementary/weekly-annoucements', '/schools/east-elementary/weekly-announcements'] },
  { name: 'Cottage School', paths: ['/schools/cottage-school/weekly-announcements', '/schools/cottage-school/weekly-annoucements'] },
  { name: 'Junior High', paths: ['/schools/junior-high/weekly-annoucements', '/schools/junior-high/weekly-announcements'] },
  { name: 'High School', paths: ['/schools/high-school/weekly-announcements', '/schools/high-school/weekly-annoucements'] },
  { name: 'College Pathways', paths: ['/schools/college-pathways/weekly-announcements', '/schools/college-pathways/weekly-annoucements'] },
]

const BASE = 'https://www.tcatitans.org'
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TCAHub/1.0)' }

const GRADES = ['kindergarten', '1st grade', '2nd grade', '3rd grade', '4th grade', '5th grade', '6th grade']

/** Strips chrome so the site's nav menu doesn't read as page content. */
function pageText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|td|th)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&[a-z]+;/g, ' ').replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim()
}

/* The site chrome is ~350-450 characters of nav and search markup, identical on
 * every one of these pages, and it dwarfs an empty page's actual body. Measuring
 * raw length therefore measures the header: Cottage School and College Pathways
 * both come to exactly 451 characters and contain nothing at all.
 *
 * The chrome ends at the last "Menu / Open" pair, after which the page repeats
 * its own heading and then begins. Stripping both leaves the real body — 152
 * characters for those two pages, versus 1,585 for one carrying content.
 */
function pageBody(text: string): string {
  const marks = [...text.matchAll(/Menu\s*\n?\s*Open/gi)]
  const cut = marks.length ? (marks[marks.length - 1].index ?? 0) + marks[marks.length - 1][0].length : 0
  return text.slice(cut).replace(/^\s*(Weekly\s+)?Annou?ncements\s*/i, '').trim()
}

/* Whether a page carries a newsletter worth storing *this* school year.
 *
 * Two separate ways to be worthless, and both are live on the site right now.
 *
 * Empty: the pages exist year-round and sit bare out of season. Writing that
 * emptiness into the corpus would supersede last week's real newsletter with
 * nothing, so an empty page must leave the stored copy alone.
 *
 * Stale: these are archive indexes, not just this week's post. Junior High
 * currently lists 62 documents and High School 36 — every one of them from
 * 2025-26. Ingesting the page as found would import a year of last year's
 * newsletters, which is the exact opposite of the point.
 */
function hasContent(body: string, docCount: number): boolean {
  return docCount > 0 || body.length >= 200
}

// Full names and abbreviations both appear in real labels — "August 2025" next
// to "JH Announcements Aug 14 2025" on the same page. Order matters: the longer
// spelling has to be tried first or "jan" would match and stop inside "january".
const MONTHS = [
  ['january', 'jan'], ['february', 'feb'], ['march', 'mar'], ['april', 'apr'],
  ['may'], ['june', 'jun'], ['july', 'jul'], ['august', 'aug'],
  ['september', 'sept', 'sep'], ['october', 'oct'], ['november', 'nov'], ['december', 'dec'],
]
const MONTH_ALTERNATION = MONTHS.flat().join('|')

/** School year runs Aug-Jun, so it starts in the calendar year Jul onward. */
function schoolYearStartOf(now: Date): number {
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1
}

/* Keeps a document only if its own label dates it to the current school year.
 *
 * Labels carry their date plainly — "May 18, 2026", "August 2025", "2025-2026".
 * Anything before August of the current school year start belongs to a year
 * nobody is asking about. A label with no date at all is kept: an untitled
 * link on a live page is far more likely to be this week's post than an
 * archive entry, and supersession will replace it next run anyway.
 */
function isCurrentSchoolYear(label: string, now: Date): boolean {
  const start = schoolYearStartOf(now)

  const span = label.match(/\b(20\d{2})\s*[-–]\s*(?:20)?(\d{2})\b/)
  if (span) return Number(span[1]) >= start

  // The day number sits between month and year — "January 12 2026", "May 18,
  // 2026" — so the gap has to allow digits. A non-digit-only gap silently fails
  // to match, falls through to the bare-year test below, and every Jan-May
  // label from the *previous* school year reads as current: 32 of Junior High's
  // 62 archived newsletters slipped through exactly that way.
  const monthYear = label.toLowerCase().match(
    new RegExp(String.raw`\b(${MONTH_ALTERNATION})\b\.?\s*\d{0,2}\s*,?\s*(20\d{2})`)
  )
  if (monthYear) {
    const month = MONTHS.findIndex(names => names.includes(monthYear[1]))
    const year = Number(monthYear[2])
    // August starts the year; Jan-Jul belong to the year that began the prior August.
    return (month >= 7 ? year : year - 1) >= start
  }

  const bareYear = label.match(/\b(20\d{2})\b/)
  if (bareYear) return Number(bareYear[1]) >= start

  return true
}

function detectGrade(label: string): string | null {
  const l = label.toLowerCase()
  const hit = GRADES.find(g => l.includes(g))
  return hit ? hit.replace(/\s+/g, '-') : null
}

export async function POST(req: NextRequest) {
  if (!isCrawlAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const dryRun = searchParams.get('dryRun') === '1'

  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()

  const { VoyageAIClient } = await import('voyageai')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })

  const results: Record<string, unknown>[] = []

  for (const campus of CAMPUSES) {
    let html = ''
    let sourceUrl = ''
    for (const path of campus.paths) {
      try {
        const res = await fetch(BASE + path, { headers: UA, signal: AbortSignal.timeout(15000) })
        if (res.ok) { html = await res.text(); sourceUrl = BASE + path; break }
      } catch { /* try the next spelling */ }
    }

    if (!html) {
      results.push({ campus: campus.name, status: 'no-page' })
      continue
    }

    const text = pageText(html)
    const body = pageBody(text)
    const nowDate = new Date()
    const allDocs = [...html.matchAll(
      /<a[^>]+href=["']([^"']*(?:\/fs\/resource-manager\/view\/[a-f0-9-]+|resources\.finalsite\.net\/[^"']+))["'][^>]*>([\s\S]{0,120}?)<\/a>/gi
    )].map(m => ({
      href: m[1].startsWith('http') ? m[1] : BASE + m[1],
      label: m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(),
    }))

    // Drop archive entries from previous school years before deciding whether
    // the page has anything worth storing — a page listing only last year's
    // newsletters has no current content, however many links it carries.
    const docs = allDocs.filter(d => isCurrentSchoolYear(d.label, nowDate))
    const staleDropped = allDocs.length - docs.length

    // A page whose only documents were stale has nothing current to store, and
    // its body is the archive index that listed them ("August 2025, September
    // 2025, ...") — itself last year's. Storing that would put a menu of
    // previous-year months into the corpus under a "current newsletter" key.
    const nothingCurrent = docs.length === 0 && staleDropped > 0

    if (nothingCurrent || !hasContent(body, docs.length)) {
      // Out of season, or the page simply has nothing this week. Leave whatever
      // is already stored in place — see hasContent().
      results.push({ campus: campus.name, status: 'empty', sourceUrl, bodyChars: body.length, staleDropped })
      continue
    }

    const keyBase = `newsletter://${campus.name.toLowerCase().replace(/\s+/g, '-')}`

    if (dryRun) {
      results.push({
        campus: campus.name, status: 'would-ingest', sourceUrl,
        bodyChars: body.length, documents: docs.length, staleDropped,
        keys: [keyBase, ...docs.map(d => `${keyBase}/${detectGrade(d.label) ?? 'general'}`)].slice(0, 8),
      })
      continue
    }

    // Supersede: clear this campus's whole key range, then write the current week.
    await supabase.from('page_chunks').delete().ilike('url', `${keyBase}%`)

    let inserted = 0
    const stored = await storeChunks(
      supabase, voyage,
      { url: keyBase, title: `${campus.name} — Weekly Announcements`, content: sanitizeForPostgres(body) },
      now
    )
    inserted += stored.inserted

    for (const doc of docs) {
      const grade = detectGrade(doc.label)
      const url = `${keyBase}/${grade ?? 'general'}`
      const label = doc.label || 'Weekly Announcement'
      const s = await storeChunks(
        supabase, voyage,
        { url, title: `${campus.name} — ${label}`.slice(0, 200), content: sanitizeForPostgres(`${label}\n${doc.href}`) },
        now
      )
      inserted += s.inserted
    }

    results.push({ campus: campus.name, status: 'ok', sourceUrl, documents: docs.length, staleDropped, chunksInserted: inserted })
  }

  return NextResponse.json({ dryRun, campuses: CAMPUSES.length, results })
}

export async function GET(req: NextRequest) {
  if (!isCrawlAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return POST(req)
}
