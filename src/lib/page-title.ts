// Making a chunk's title say which campus it belongs to.
//
// TCA runs seven campuses off one site, and every campus page is titled by
// Finalsite from its own perspective — so twelve different pages are titled
// "Homepage", and 98 of the 237 chunks under /schools/<campus>/ have a title
// that never names the campus they describe.
//
// That is not cosmetic. The College Pathways homepage carries a full bell
// schedule, eight periods ending at 3:10pm, under the title "Homepage". Asked
// "what time does the high school day end", the app retrieved it and answered
// 3:10 — the high school day ends at 3:00, and the answer varied between the
// two depending on which chunk retrieval happened to reach first. The content
// says "COLLEGE PATHWAYS BELL SCHEDULE" in plain text; the title said nothing,
// and the title is what the source label under an answer shows a parent.
//
// So the campus is put back into the title where the URL knows it and the title
// doesn't say it.

const CAMPUS_NAMES: Record<string, string> = {
  'east-elementary': 'East Elementary',
  'central-elementary': 'Central Elementary',
  'north-elementary': 'North Elementary',
  'junior-high': 'Junior High',
  'high-school': 'High School',
  'college-pathways': 'College Pathways',
  'cottage-school': 'Cottage School',
}

/** The campus a URL belongs to, if it is under one. */
export function campusOf(url: string): string | null {
  const m = url.match(/\/schools\/([a-z-]+)/)
  return (m && CAMPUS_NAMES[m[1]]) || null
}

/**
 * A title that identifies the page on its own.
 *
 * Drops the site name Finalsite appends to every <title>, then prefixes the
 * campus when the URL has one and the title doesn't already name it. A page
 * already called "High School Hours/Bell Schedule" is left alone.
 */
export function qualifiedTitle(rawTitle: string, url: string): string {
  const title = rawTitle
    .replace(/\s*[-|]\s*The Classical Academy\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()

  const campus = campusOf(url)
  if (!campus) return title
  if (!title) return campus
  if (title.toLowerCase().includes(campus.toLowerCase())) return title
  return `${campus} — ${title}`
}
