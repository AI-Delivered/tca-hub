import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isCrawlAuthorized } from '@/lib/auth'
import { storeChunks, sanitizeForPostgres } from '@/lib/ingest-chunks'
import { withIngestLog } from '@/lib/ingest-log'
import { identityRefusal } from '@/lib/school-identity'
import { fetchSmoreNewsletter, parseSmoreUrl } from '@/lib/smore'

export const maxDuration = 300

/* School mail that exists nowhere else.
 *
 * The three elementary campuses have no announcements page, and the secondary
 * campuses send plenty that never reaches the website either — the 7th grade
 * BOOT Camp mail that prompted this route carried the arrival window, the
 * dismissal time, the lunch signup and a new wheeled-transport policy, none of
 * which appear on tcatitans.org. A crawler cannot reach any of it.
 *
 * This is the *sink*, deliberately built before the transport. The plan on file
 * was a dedicated address TCA delivers to, and that is still blocked on the
 * school — but the blocker was never the code that stores a message, and that
 * code can be verified today against real mail sitting in a real inbox. When a
 * mailbox does exist, whatever polls it POSTs here and nothing below changes.
 *
 * Text arrives already cleaned by the caller. That is not laziness about HTML
 * parsing: a human decides what is safe to publish to every TCA parent, which
 * is a judgement no parser makes. See the redaction note on `redact` below.
 */

/** Synthetic scheme, matching the `newsletter://` convention. Keeps these rows
 *  trivially deletable as a key range and stops them colliding with a crawled
 *  https:// copy if the same content ever does get posted. */
const SCHEME = 'email://'

/* Why an expiry, when `newsletter://` gets by without one.
 *
 * A crawled newsletter is overwritten by next Saturday's run whether or not
 * anyone remembers it exists. A pasted one is only ever superseded by someone
 * choosing to paste again — so the failure mode is not a stale week, it is an
 * August orientation email still answering questions in November because the
 * person who pasted it moved on. Nothing in the pipeline notices.
 *
 * The date rides in the key (`?until=YYYY-MM-DD`) rather than a column: adding
 * one means a migration, and migrations on this project are hand-applied in the
 * Supabase console. A suffix costs nothing and is self-describing in the row.
 *
 * Content with no shelf life — a policy, a dress code — is stored without one
 * and stays until it is replaced.
 */
const UNTIL = '?until='

/** `%` and `_` are ilike wildcards, and a slug goes straight into a delete
 *  pattern. Anchored so a caller cannot widen their own supersession range. */
const SLUG = /^[a-z0-9]+(?:[/-][a-z0-9]+)*$/

interface Body {
  /** Key within the scheme, e.g. `junior-high/boot-camp-2026`. Pasted path only. */
  slug?: unknown
  title?: unknown
  text?: unknown
  /** A Smore newsletter URL, instead of `text`. See the Smore note below. */
  url?: unknown
  /** YYYY-MM-DD. Omit for content that does not go stale. On the Smore path,
   *  omit to derive it from the issue date on the page. */
  until?: unknown
  /** Literal strings to scrub before anything is stored.
   *
   *  Almost every school email is addressed to one family — "Dear Parents of
   *  incoming TCA 7th-Grader <name>" — while the body underneath went to a
   *  whole grade. The body is worth having; the name is a child's, and this
   *  corpus answers questions for every other parent at the school. Passed
   *  explicitly rather than guessed at by a regex, because a redactor that
   *  silently misses is worse than one that was never claimed to exist. */
  redact?: unknown
  dryRun?: unknown
  allowUnverifiedSchool?: unknown
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : []
}

/** Longest first, so scrubbing "Cooper" cannot strand the surname in
 *  "Cooper MacAlmon" before the full name is matched. */
function redactText(text: string, names: string[]): { text: string; hits: number } {
  let out = text
  let hits = 0
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    const found = out.match(pattern)
    if (found) hits += found.length
    out = out.replace(pattern, '[student name]')
  }
  return { text: out, hits }
}

/* Newsletters that live on Smore.
 *
 * TCA sends campus newsletters as Smore broadcasts, not as documents on
 * tcatitans.org — so the content the elementary campuses never publish is in
 * fact on a public web page, and does not need a mailbox at all. What it needs
 * is the address: each issue is a fresh 5-character id, no page links to
 * another, and the current issue is in no search index, so nothing can derive
 * next week's URL. An email (or the school publishing the link) is a courier for
 * one string; `src/lib/smore.ts` does the rest.
 *
 * Two things fall out of using the real page rather than the email body.
 *
 * The row is stored under its true https:// URL, so a citation is a link a
 * parent can open — the newsletter is the authoritative source and old issues
 * stay live indefinitely. That is worth more than the tidiness of a synthetic
 * key, so the expiry rides in a `#until=` fragment instead of `?until=`: a
 * fragment is ignored when the link is followed, so the citation still lands on
 * the newsletter, and the sweep can still read the date.
 *
 * And no redaction is needed. The email is addressed to one family; the Smore
 * broadcast it links to is not addressed to anyone, so there is no student name
 * in it to scrub. `redact` still runs — it costs nothing and the day a
 * personalised Smore page appears is not the day to find out.
 */
const SMORE_UNTIL = '#until='
/** Weekly cadence plus a week of grace: an issue stays answerable through the
 *  week it describes, and disappears rather than aging into a wrong answer. */
const SMORE_SHELF_DAYS = 14

/**
 * Drop every stored message whose expiry date has passed.
 *
 * Runs on ingest and on the daily cron, so an expiry is honoured even if
 * nothing is ever pasted again — which is the whole point of having one.
 * Read-then-delete rather than a SQL predicate because the date lives inside
 * the key; the set is a handful of rows, so the read is free.
 *
 * Matches on `until=` alone so it covers both key shapes — `?until=` on
 * `email://` and `#until=` on a Smore URL. A crawled page that happened to
 * carry an `until=` query parameter would be read too, and then ignored,
 * because the value has to parse as a date before anything is deleted.
 */
async function sweepExpired(supabase: ReturnType<typeof getSupabaseAdmin>, today: string): Promise<string[]> {
  const { data } = await supabase.from('page_chunks').select('url').ilike('url', '%until=%')
  const expired = [...new Set((data ?? []).map(r => String(r.url)))]
    .filter(url => {
      const at = Math.max(url.lastIndexOf(UNTIL), url.lastIndexOf(SMORE_UNTIL))
      if (at === -1) return false
      const until = url.slice(url.indexOf('until=', at) + 'until='.length)
      return /^\d{4}-\d{2}-\d{2}$/.test(until) && until < today
    })
  for (const url of expired) await supabase.from('page_chunks').delete().eq('url', url)
  return expired
}

function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

async function smoreIngest(opts: {
  supabase: ReturnType<typeof getSupabaseAdmin>
  today: string
  smoreUrl: string
  until: string
  title: string
  redact: string[]
  dryRun: boolean
  allowUnverifiedSchool: boolean
}): Promise<NextResponse> {
  const { supabase, today, smoreUrl, until, title, redact, dryRun, allowUnverifiedSchool } = opts

  if (!parseSmoreUrl(smoreUrl)) {
    return NextResponse.json(
      { error: 'url must look like https://app.smore.com/n/<id>-<slug>' }, { status: 400 })
  }

  let issue
  try {
    issue = await fetchSmoreNewsletter(smoreUrl)
  } catch (err) {
    // Surfaced rather than swallowed: every way this fails — unrendered SPA,
    // main-content stripping, a missing key — produces an empty page, and an
    // empty page stored quietly is the failure this route exists to avoid.
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 502 })
  }

  /* The page has to say whose it is.
   *
   * The provenance line below calls this "the TCA campus newsletter" and the
   * chunks are stored where the search route reads them as TCA's own words, so a
   * mis-pasted URL does not produce a bad citation — it produces another school's
   * dates in this school's voice. Searching for TCA's newsletter turns up several
   * publications called "Titan eNews", at least one belonging to Academy High
   * School: same district, same city, same Titan branding, same platform, and a
   * URL with no slug in it to tell them apart. This is the check that a human
   * skimming search results does not reliably make. */
  const refusal = allowUnverifiedSchool ? '' : identityRefusal(`${issue.title}\n${issue.text}`, issue.url)
  if (refusal) return NextResponse.json({ error: refusal }, { status: 422 })

  /* The expiry comes from the issue, not from the caller.
   *
   * A newsletter states the week it covers, so nobody should have to compute a
   * date by hand — and if the page has no readable date, that is a signal the
   * layout changed, which is exactly when a silently wrong expiry does damage.
   * So an unparseable date is an error unless the caller names one. */
  if (!until && !issue.issueDate) {
    return NextResponse.json({
      error: `could not read an issue date from ${issue.url} — pass until=YYYY-MM-DD explicitly`,
    }, { status: 422 })
  }
  const expiry = until || addDays(issue.issueDate!, SMORE_SHELF_DAYS)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    return NextResponse.json({ error: 'until must be YYYY-MM-DD' }, { status: 400 })
  }
  if (expiry < today) {
    return NextResponse.json({
      error: `issue dated ${issue.issueDate} expired ${expiry} — that is a past issue, not the current one`,
    }, { status: 400 })
  }

  const heading = title || `${issue.title}${issue.issueDate ? ` — ${issue.issueDate}` : ''}`
  const provenance =
    `Source: ${issue.title}, the TCA campus newsletter published on Smore` +
    `${issue.issueDate ? ` for the week of ${issue.issueDate}` : ''}. ` +
    `Sent to families by email and readable at ${issue.url}. It is not published on tcatitans.org, ` +
    `so this is the only place the information below appears.`

  const { text: redacted, hits } = redactText(`${provenance}\n\n${issue.text}`, redact)
  const key = `${issue.url}${SMORE_UNTIL}${expiry}`

  if (dryRun) {
    return NextResponse.json({
      mode: 'dryRun', source: 'smore', key, title: heading,
      issueDate: issue.issueDate, expires: expiry,
      chars: redacted.length, redactions: hits,
      preview: redacted.slice(0, 500),
    })
  }

  const swept = await sweepExpired(supabase, today)

  /* Supersede on the publication, not the issue.
   *
   * The id changes every week, so matching the key would never replace anything
   * and every issue would pile up — a month of East newsletters answering the
   * same question four different ways. The trailing slug is what is stable
   * (`…-tca-east-elementary-news` on every East issue), so that is the range to
   * clear. `parseSmoreUrl` has already refused anything but `[a-z0-9-]`, so no
   * ilike wildcard can reach this pattern. */
  await supabase.from('page_chunks').delete().ilike('url', `%-${issue.publicationSlug}%`)

  const { VoyageAIClient } = await import('voyageai')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })

  const stored = await storeChunks(
    supabase, voyage,
    { url: key, title: heading.slice(0, 200), content: sanitizeForPostgres(redacted) },
    new Date().toISOString()
  )

  return NextResponse.json({
    mode: 'ingest', source: 'smore', key, title: heading,
    issueDate: issue.issueDate, expires: expiry,
    chars: redacted.length, redactions: hits,
    chunks: stored.chunks, chunksInserted: stored.inserted, errors: stored.errors,
    swept,
  })
}

async function run(req: NextRequest) {
  if (!isCrawlAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = getSupabaseAdmin()
  const now = new Date()
  const today = now.toLocaleDateString('en-CA', { timeZone: 'America/Denver' }) // YYYY-MM-DD

  // GET is the sweeper only — there is no body to ingest, and the cron calls it
  // purely so expiries land on the day they say they will.
  if (req.method === 'GET') {
    const swept = await sweepExpired(supabase, today)
    return NextResponse.json({ mode: 'sweep', today, swept })
  }

  const body = (await req.json().catch(() => null)) as Body | null
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 })
  }

  const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : ''
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  const until = typeof body.until === 'string' ? body.until.trim() : ''
  const smoreUrl = typeof body.url === 'string' ? body.url.trim() : ''
  const dryRun = body.dryRun === true
  const allowUnverifiedSchool = body.allowUnverifiedSchool === true

  if (smoreUrl) {
    if (text) {
      return NextResponse.json({ error: 'pass url or text, not both' }, { status: 400 })
    }
    return smoreIngest({
      supabase, today, smoreUrl, until, title,
      redact: asStringArray(body.redact), dryRun, allowUnverifiedSchool,
    })
  }

  if (!SLUG.test(slug)) {
    return NextResponse.json({ error: 'slug must be lowercase a-z0-9, separated by - or /' }, { status: 400 })
  }
  if (!title) return NextResponse.json({ error: 'title required' }, { status: 400 })
  if (text.length < 40) return NextResponse.json({ error: 'text too short to be worth storing' }, { status: 400 })
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    return NextResponse.json({ error: 'until must be YYYY-MM-DD' }, { status: 400 })
  }
  if (until && until < today) {
    return NextResponse.json({ error: `until ${until} is already past — nothing would be retrievable` }, { status: 400 })
  }

  const { text: redacted, hits } = redactText(text, asStringArray(body.redact))

  const keyBase = `${SCHEME}${slug}`
  const key = until ? `${keyBase}${UNTIL}${until}` : keyBase

  if (dryRun) {
    return NextResponse.json({
      mode: 'dryRun', key, title, chars: redacted.length, redactions: hits,
      preview: redacted.slice(0, 400),
    })
  }

  const swept = await sweepExpired(supabase, today)

  /* Supersede on the slug, not the full key.
   *
   * The expiry is part of the key, so re-pasting the same message with a new
   * date would otherwise leave the old copy in place alongside it — two
   * answers to the same question, differing only in a date nobody sees. The
   * prefix match catches every previous `?until=` for this slug.
   *
   * Consequence worth knowing: slug `junior-high/boot-camp` would also clear
   * `junior-high/boot-camp-2026`. Slugs are chosen by hand, so this is a note
   * rather than a guard. */
  await supabase.from('page_chunks').delete().ilike('url', `${keyBase}%`)

  const { VoyageAIClient } = await import('voyageai')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })

  const stored = await storeChunks(
    supabase, voyage,
    { url: key, title: title.slice(0, 200), content: sanitizeForPostgres(redacted) },
    now.toISOString()
  )

  return NextResponse.json({
    mode: 'ingest', key, title,
    chars: redacted.length, redactions: hits,
    chunks: stored.chunks, chunksInserted: stored.inserted, errors: stored.errors,
    swept,
  })
}

function handler(req: NextRequest) {
  return withIngestLog(req, '/api/crawl/ingest-email', () => run(req))
}

export const GET = handler
export const POST = handler
