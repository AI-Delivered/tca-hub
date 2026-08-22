/* Reading a MaxPreps team stats page, and refusing to pretend when it cannot.
 *
 * GoBound is the school's own system and its statistics are, in this corpus,
 * largely empty — which is why this exists: MaxPreps is where TCA's football
 * numbers actually live. It is also a page nobody here has been able to look at.
 * The environment this was written in cannot reach maxpreps.com, so every parser
 * below is written against the shapes such a page *can* take rather than against
 * markup anyone has seen, and that fact decides the design:
 *
 *   Nothing is stored on a guess. A page that yields no recognisable stat table
 *   is an error with a diagnosis, not an empty chunk written quietly. The repo has
 *   been here before — "an empty page stored quietly is the failure this route
 *   exists to avoid" — and an unrendered SPA shell is the most likely thing a
 *   server-side fetch of a modern sports site returns.
 *
 *   The three ways this fails are told apart, because they need different fixes:
 *   blocked by bot protection, rendered by JavaScript we did not run, or fetched
 *   fine and shaped differently than expected. "No stats found" for all three
 *   sends someone looking in the wrong place.
 *
 *   And the page has to be TCA's. MaxPreps hosts every school in the country
 *   under near-identical URLs; one wrong slug and another team's numbers are
 *   stored as this school's, which is the mistake a Titan eNews already nearly
 *   made here.
 */

/** Common entities, which a stats table is full of (&amp;, &#39;, &nbsp;). */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;|&rsquo;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

export interface StatTable {
  /** The heading above the table — Passing, Rushing, Defense. */
  category: string
  headers: string[]
  rows: string[][]
}

/* A cell that carries a number, which is what separates a stats table from the
 * navigation, the schedule and the cookie banner.
 *
 * Thousands separators are stripped first, and that is not a detail. Without it
 * "1,204" is not a number, and the rows most likely to be written that way are
 * season passing and rushing yardage — so a table could be dropped for having
 * *large* numbers in it, and the drop would be silent. Found by a fixture where
 * the only two stat columns were "1,204" and "14"; the happy-path table hid it by
 * having three other columns that did parse. */
const numeric = (value: string) => /^-?\d+(?:[./]\d+)?%?$/.test(value.replace(/,/g, ''))
const numberOf = (value: string) => Number.parseFloat(value.replace(/,/g, ''))

function parseTable(tableHtml: string): { headers: string[]; rows: string[][] } {
  const rowHtml = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1])
  if (rowHtml.length < 2) return { headers: [], rows: [] }

  const cellsOf = (html: string, tag: string) =>
    [...html.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map(c => stripTags(c[1]))

  // A header row is <th> where the page bothers, and the first <td> row where it
  // does not.
  const headers = cellsOf(rowHtml[0], 'th').length ? cellsOf(rowHtml[0], 'th') : cellsOf(rowHtml[0], 'td')
  const rows: string[][] = []
  for (const html of rowHtml.slice(1)) {
    const cells = cellsOf(html, 'td')
    if (!cells.length) continue
    const [name, ...values] = cells
    // A stat row names somebody and then counts something. Anything else is a
    // layout row, a totals banner, or an advert that happens to live in a table.
    if (!name || numeric(name)) continue
    if (values.filter(numeric).length < 2) continue
    // Every number zero means the player has not played; it is noise in an answer.
    if (values.every(v => !numeric(v) || numberOf(v) === 0)) continue
    rows.push(cells)
  }
  return { headers, rows }
}

/** Every stat table on the page, with the heading that introduces each. */
export function parseStatTables(html: string): StatTable[] {
  const tables: StatTable[] = []
  const tableRe = /<table[\s\S]*?<\/table>/gi
  let match: RegExpExecArray | null
  while ((match = tableRe.exec(html)) !== null) {
    const { headers, rows } = parseTable(match[0])
    if (!rows.length) continue

    /* The nearest heading above the table, which is what says whether these are
     * passing or receiving numbers. Read backwards from the table so a page with
     * five sections does not label them all with its <h1>. */
    const before = html.slice(0, match.index)
    const heading = [...before.matchAll(/<(?:h[1-5]|caption)[^>]*>([\s\S]*?)<\/(?:h[1-5]|caption)>/gi)].pop()
    const category = heading ? stripTags(heading[1]) : (headers[0] || 'Stats')
    tables.push({ category: category.slice(0, 60), headers, rows })
  }
  return tables
}

export type PageProblem = 'blocked' | 'javascript-only' | 'unrecognised' | 'wrong-school'

export interface PageReading {
  problem?: PageProblem
  /** What to do about it, in the terms of the thing that is wrong. */
  detail?: string
  tables: StatTable[]
  /** Facts about what came back, for a dry run to report. */
  shape: { bytes: number; tables: number; hasEmbeddedJson: boolean; textPreview: string }
}

/* Bot protection, which CBS properties use and which returns 200 with a page that
 * looks like a page. Told apart from an empty result because the fix is entirely
 * different: no amount of parser work gets past a challenge. */
const CHALLENGE = /(?:just a moment|checking your browser|cf-browser-verification|px-captcha|perimeterx|access denied|are you a robot)/i

/** JavaScript-rendered shells: markup arrives, content does not. */
const JSON_BLOB = /<script[^>]*(?:id="__NEXT_DATA__"|type="application\/json")[^>]*>/i

export function readStatsPage(input: {
  html: string
  status: number
  /** Does this page identify itself as the school we mean? */
  identifiesSchool: boolean
}): PageReading {
  const { html, status } = input
  const text = stripTags(html)
  const shape = {
    bytes: html.length,
    tables: (html.match(/<table/gi) ?? []).length,
    hasEmbeddedJson: JSON_BLOB.test(html),
    textPreview: text.slice(0, 300),
  }

  if (status === 403 || status === 429 || CHALLENGE.test(text.slice(0, 4000))) {
    return {
      problem: 'blocked',
      detail: `MaxPreps refused the request (HTTP ${status}${CHALLENGE.test(text) ? ', bot challenge in the body' : ''}). ` +
        'This is not a parsing problem and no parser change will fix it — the page is behind bot protection.',
      tables: [], shape,
    }
  }

  /* Identity before content. MaxPreps hosts every school in the country under
   * near-identical URLs, so a wrong slug returns a perfectly good stats page
   * belonging to somebody else. */
  if (!input.identifiesSchool) {
    return {
      problem: 'wrong-school',
      detail: 'the page never names The Classical Academy — check the URL slug is this school\'s ' +
        'before storing anything from it',
      tables: [], shape,
    }
  }

  const tables = parseStatTables(html)
  if (tables.length) return { tables, shape }

  if (shape.hasEmbeddedJson || shape.tables === 0) {
    return {
      problem: 'javascript-only',
      detail: shape.hasEmbeddedJson
        ? 'the stats are not in the HTML — the page ships them as JSON for the browser to render. ' +
          'Either read that blob (its shape is in the dry run) or fetch through a browser.'
        : 'the page came back with no table markup at all, so there was nothing to read.',
      tables: [], shape,
    }
  }

  return {
    problem: 'unrecognised',
    detail: `${shape.tables} table(s) on the page and none of them held rows that look like statistics ` +
      '(a name followed by numbers) — the page layout is not what this parser expects',
    tables: [], shape,
  }
}

/** The stored text: one line per athlete, headed by the category it belongs to. */
export function statsToText(input: {
  sport: string
  season: string
  tables: StatTable[]
  sourceUrl: string
  fetchedOn: string
}): string {
  const lines = [
    `TCA ${input.sport} ${input.season} Statistics (MaxPreps, read ${input.fetchedOn}):`,
    `Source: ${input.sourceUrl}`,
  ]
  for (const table of input.tables) {
    lines.push('', `${table.category}:`)
    if (table.headers.length) lines.push(`  ${table.headers.join(' | ')}`)
    for (const row of table.rows) lines.push(`  ${row.join(' | ')}`)
  }
  return lines.join('\n')
}

/* Enough of a squad to be worth storing.
 *
 * One row is what a half-rendered page or a stray advert table produces, and a
 * football stats page with one player on it is not a football stats page. Storing
 * it would put a chunk in the corpus that answers "who leads the team in passing"
 * with whatever the advert said. */
export const MIN_STAT_ROWS = 3

export function totalRows(tables: StatTable[]): number {
  return tables.reduce((n, t) => n + t.rows.length, 0)
}
