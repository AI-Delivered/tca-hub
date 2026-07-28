// Separating a page's actual content from the site furniture around it.
//
// Every page on tcatitans.org carries the same ~200 characters of chrome before
// its content starts:
//
//   "Skip To Main Content Close Menu Search search-form#clearSearch'> Clear
//    Search The Classical Academy Excellence with Honor Open Search Search …
//    Menu Open"
//
// Indexing that had two costs, and the second one is the expensive one.
//
// It is repeated in ~400 chunks, which dilutes every embedding with text that
// is identical everywhere and therefore distinguishes nothing. Worse, it makes
// an empty page look substantive: the High School Hours/Bell Schedule page is
// 279 characters of which 279 are chrome — the schedule itself is a linked PDF
// — and it cleared the crawler's 150-character "has content" floor on chrome
// alone. So the corpus held a page titled "High School Hours/Bell Schedule"
// containing no hours, and that page outranked the extracted PDF that had them,
// because its title is nearly the question a parent asks. "What time does the
// high school day end" was answered with "I don't have the specific times",
// while 7:45–3:00 sat in the corpus one row away.
//
// ingest-newsletters worked this out first and had its own copy; this is that
// logic, shared, so the crawler gets it too.

/** Text after the last navigation marker — the page's own content. */
export function pageBody(text: string): string {
  const marks = [...text.matchAll(/Menu\s*\n?\s*Open/gi)]
  const last = marks[marks.length - 1]
  const cut = last ? (last.index ?? 0) + last[0].length : 0
  return text.slice(cut).trim()
}

/**
 * Whether a page has enough of its own content to be worth indexing.
 *
 * Measured on the chrome alone: `pageBody` of a shell page leaves the title
 * echoed once or twice and nothing else, so a floor well above that separates
 * "a page about something" from "a link to a PDF".
 */
export function hasBodyContent(text: string, min = 150): boolean {
  return pageBody(text).length >= min
}
