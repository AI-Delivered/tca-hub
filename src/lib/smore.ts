// Reading a TCA campus newsletter off Smore.
//
// TCA does not publish campus newsletters as documents on tcatitans.org — it
// sends them as Smore broadcasts, and every issue is a public web page. That
// makes them reachable without a mailbox, which the email-ingest plan had
// assumed was impossible. What is *not* reachable is the address of next week's
// issue: measured on two consecutive East issues, 3bzd4 (8/1/26) and ehg53
// (8/8/26), each week is a new page under a fresh 5-character id, the pages do
// not link to each other, there is no publisher archive, and the current issue
// is not in any search index. So a URL still has to be handed to us — but once
// it is, everything below is automatic.
//
// Two traps, both of which look exactly like "the page is empty":
//
//   1. app.smore.com is a JS-rendered SPA. A plain fetch returns a shell with
//      the <title> and nothing else, so the crawler would have stored a title
//      and no content and reported success.
//   2. Firecrawl's `onlyMainContent` default of true strips the entire
//      newsletter body — Smore's DOM defeats the main-content heuristic. With it
//      off, the same page yields ~14k characters.

/* Smore serves the same page from several hosts and 302s them to app.smore.com.
 *
 * The slug is optional, because the address a parent is actually handed often has
 * no slug in it: https://app.smore.com/n/fnkg61 is a real East issue. This used to
 * be rejected outright, so the one URL shape people forward was the one shape this
 * could not read.
 *
 * The slug is not decoration, though — it names the *publication* rather than the
 * issue, and it is what a new issue supersedes its predecessor on. Without it the
 * caller has an id and nothing to group by, which is why `publicationSlug` is null
 * here rather than empty: an empty string reaches the supersession delete as the
 * pattern `%-%`, which matches nearly every url in the corpus. A missing slug has
 * to be resolved before anything is written, never defaulted. */
const SMORE_HOST = /^https:\/\/(?:app|secure|www)\.smore\.com\/n\/([a-z0-9]+)(?:-([a-z0-9-]+))?\/?$/i

export interface SmoreNewsletter {
  /** Canonical app.smore.com URL, query and fragment stripped. */
  url: string
  /** The `<id>-<slug>` id, e.g. `ehg53`. Changes every issue. */
  issueId: string
  /** The stable part of the path, e.g. `tca-east-elementary-news`. Identifies
   *  the publication rather than the issue, so it is what supersession groups
   *  on — every East issue ends with the same slug. Null when the URL had no slug
   *  and neither the redirect nor the title could supply one; nothing may be
   *  written in that state. */
  publicationSlug: string | null
  /** Where that slug came from, weakest last. */
  publicationSource: 'url' | 'canonical' | 'title' | 'unresolved'
  /** Documents the issue links to — the grade-level newsletters and forms that
   *  carry detail the issue itself only summarises. */
  documents: Array<{ label: string; url: string }>
  title: string
  /** Issue date as YYYY-MM-DD, read from the page. Null if unparseable. */
  issueDate: string | null
  /** Cleaned body text. */
  text: string
}

export function parseSmoreUrl(raw: string): { issueId: string; publicationSlug: string | null; url: string } | null {
  const m = raw.trim().split(/[?#]/)[0].match(SMORE_HOST)
  if (!m) return null
  const [, issueId, slug] = m
  if (slug === undefined) return { issueId, publicationSlug: null, url: `https://app.smore.com/n/${issueId}` }
  // The slug lands in an ILIKE delete pattern, where `_` matches any character.
  // Real slugs are hyphenated lowercase, so anything else is rejected rather
  // than escaped — a caller must not be able to widen their own delete range.
  if (!isPublicationSlug(slug)) return null
  return { issueId, publicationSlug: slug, url: `https://app.smore.com/n/${issueId}-${slug}` }
}

/* What may be used to group issues — and therefore to delete them.
 *
 * Three characters minimum, and hyphenated lowercase only. The value ends up in
 * `ilike('url', '%-<slug>%')`, so a short or empty one is not a narrower delete,
 * it is a wildcard over the whole table: `%-%` matches nearly every url this app
 * stores. Anything that fails this is refused rather than escaped, and the refusal
 * is the only correct outcome — there is nothing safe to fall back to. */
export function isPublicationSlug(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length >= 3 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

/** The pattern that supersedes older issues of one publication, or null if unsafe. */
export function supersedePattern(slug: string | null | undefined): string | null {
  return isPublicationSlug(slug) ? `%-${slug}%` : null
}

/** A publication slug read off the newsletter's own title, when the URL has none. */
export function publicationSlugFromTitle(title: string): string | null {
  const slug = title.toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return isPublicationSlug(slug) ? slug : null
}

/* The chrome that precedes the newsletter.
 *
 * Every Smore page opens with a share widget, a Google Translate language
 * picker naming ~200 languages, an accessibility button and a view counter —
 * about 2,000 characters, identical on every issue, and all of it above the
 * newsletter's own `# Title`. Embedded verbatim it would be the single most
 * repeated text in the corpus and would pull every vaguely multilingual
 * question towards whichever newsletter was indexed last.
 *
 * Cutting at the first h1 removes all of it in one rule, and does not depend on
 * recognising any particular widget — a new one added above the title is
 * discarded by the same cut.
 */
function stripChrome(markdown: string): string {
  const h1 = markdown.search(/^# /m)
  return h1 === -1 ? markdown : markdown.slice(h1)
}

/** Smore renders the title and date a second time as one run-together line
 *  ("TCA EastElementary News8/8/26") for its own layout. It reads as noise and
 *  as a phantom date format, so it goes. */
function dropTitleEcho(text: string, title: string): string {
  const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  const needle = squash(title)
  return text
    .split('\n')
    .filter(line => !(line.trim() && squash(line).startsWith(needle) && squash(line) !== needle))
    .join('\n')
}

/** Images carry no text worth embedding — Smore's alt text is "User uploaded
 *  image" or "page background" — and each one drags a "Show in original size"
 *  link behind it. Links in prose are kept; these are not prose.
 *
 *  Asset links are matched by their target rather than their label. The label
 *  arrives as `zoom\_out\_map` — markdown-escaped underscores — so a literal
 *  `zoom_out_map` pattern silently misses every one of them, which is how the
 *  first version of this shipped junk into the dry run. Every image and icon
 *  Smore serves is on cdn.smore.com, and nothing quotable ever is. */
function stripImages(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    /* Every cdn.smore.com link goes, except the ones that are documents.
     *
     * Smore hosts a newsletter's attachments on the same CDN as its icons, so the
     * blanket rule that removes "zoom_out_map" also removed the grade-level
     * newsletter PDFs an issue exists to hand out — the most useful links on the
     * page, deleted as chrome. A link to a file is prose; a link to an icon is
     * not, and the extension is what separates them. */
    .replace(/\[[^\]]*\]\(https?:\/\/cdn\.smore\.com[^)]*\)/g, match =>
      DOCUMENT_URL.test(match) ? match : '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/* A link worth following: a file, not a page.
 *
 * Extensions first, then the two document hosts a school actually uses. Google
 * Drive and Docs links carry no extension at all, and a grade-level newsletter is
 * as likely to be one of those as a PDF. */
const DOCUMENT_URL =
  /\.(?:pdf|docx?|xlsx?|pptx?)(?:[?#]|$)|docs\.google\.com|drive\.google\.com|\/file\/d\//i

/** The documents an issue links to, read before the asset strip runs.
 *
 * Read from the body rather than from the cleaned text on purpose: the cleaning
 * step is allowed to change, and what is linked is a fact about the issue. */
export function linkedDocuments(markdown: string): Array<{ label: string; url: string }> {
  const found = new Map<string, string>()
  for (const match of markdown.matchAll(/(?<!!)\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)) {
    const [, rawLabel, url] = match
    if (!DOCUMENT_URL.test(url) || found.has(url)) continue
    // Markdown-escaped underscores and stray whitespace come through Firecrawl's
    // conversion; the label is what a person would see, so it is what is kept.
    const label = rawLabel.replace(/\\([_*])/g, '$1').replace(/\s+/g, ' ').trim()
    found.set(url, label || url)
  }
  return [...found].map(([url, label]) => ({ label, url }))
}

/* The issue date, which is what makes an issue supersede its predecessor.
 *
 * Smore puts it in the second heading, immediately under the title — `## 8/8/26`
 * on both East issues measured. Two-digit years are read as 20xx: these are
 * current-year school newsletters, and a 1926 newsletter is not a case worth
 * handling.
 */
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]

function parseIssueDate(text: string): string | null {
  const slash = text.match(/^#{1,3}\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*$/m)
  if (slash) {
    const [, m, d, y] = slash
    const year = y.length === 2 ? 2000 + Number(y) : Number(y)
    return `${year}-${String(Number(m)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`
  }
  const named = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/i)
  if (named) {
    // Looked up, not parsed. `new Date('August 1, 2000')` leans on the engine's
    // lenient date parser, which is implementation-defined for month names — and
    // the name was matched from this very list a line above.
    const month = MONTH_NAMES.indexOf(named[1].toLowerCase()) + 1
    return `${named[3]}-${String(month).padStart(2, '0')}-${String(Number(named[2])).padStart(2, '0')}`
  }
  return null
}

/**
 * Fetch and clean one Smore newsletter.
 *
 * Throws with a message worth reading rather than returning empty content —
 * "the page had nothing in it" is the symptom of both traps described above, and
 * a route that stored it silently is how a title with no body gets indexed.
 */
export async function fetchSmoreNewsletter(rawUrl: string): Promise<SmoreNewsletter> {
  const parsed = parseSmoreUrl(rawUrl)
  if (!parsed) throw new Error(`not a Smore newsletter URL: ${rawUrl}`)

  const key = process.env.FIRECRAWL_API_KEY
  if (!key) throw new Error('FIRECRAWL_API_KEY is not set')

  const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      url: parsed.url,
      formats: ['markdown'],
      // Both of these are load-bearing — see the header comment. Dropping either
      // yields a page that looks present and is empty.
      onlyMainContent: false,
      waitFor: 5000,
    }),
    signal: AbortSignal.timeout(90_000),
  })

  const json = await res.json().catch(() => null) as {
    success?: boolean
    error?: string
    data?: {
      markdown?: string
      metadata?: { title?: string; sourceURL?: string; url?: string; ogUrl?: string }
    }
  } | null
  if (!res.ok || !json?.success) {
    throw new Error(`Firecrawl ${res.status}: ${json?.error ?? 'no detail'}`)
  }

  const markdown = json.data?.markdown ?? ''
  const body = stripChrome(markdown)
  const title = (body.match(/^# (.+)$/m)?.[1] ?? json.data?.metadata?.title ?? '').trim()
  const issueDate = parseIssueDate(body)
  const documents = linkedDocuments(body)
  const text = stripImages(dropTitleEcho(body, title))

  /* Where the publication name comes from when the URL had none.
   *
   * A slug-less link redirects to the canonical one, and Firecrawl reports the
   * address it actually landed on — so the slug usually comes back for free. The
   * title is the fallback, and it is a weaker one: it groups issues correctly only
   * while the publication keeps calling itself the same thing, and a rename shows
   * up as an old issue that never gets superseded rather than as an error. Which
   * one was used is returned, so a caller can say so and a dry run can show it. */
  const metadata = json.data?.metadata ?? {}
  const canonical = [metadata.sourceURL, metadata.url, metadata.ogUrl]
    .map(candidate => (candidate ? parseSmoreUrl(candidate) : null))
    .find(parsed => parsed?.publicationSlug)?.publicationSlug ?? null

  const publicationSlug = parsed.publicationSlug ?? canonical ?? publicationSlugFromTitle(title)
  const publicationSource: SmoreNewsletter['publicationSource'] =
    parsed.publicationSlug ? 'url' : canonical ? 'canonical' : publicationSlug ? 'title' : 'unresolved'

  // 2,000 characters is comfortably below a real issue (13.5k and 13.9k on the
  // two measured) and comfortably above the chrome-only shell.
  if (text.length < 2000) {
    throw new Error(
      `extracted only ${text.length} chars from ${parsed.url} — expected a full newsletter. ` +
      `Check that onlyMainContent is false and the page rendered.`
    )
  }

  return {
    url: parsed.url, issueId: parsed.issueId,
    publicationSlug, publicationSource, documents,
    title, issueDate, text,
  }
}
