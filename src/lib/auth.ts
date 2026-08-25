// Comparing the shared secrets that stand in front of the crawl routes and the
// analytics dashboard.
//
// Two properties that `a === b` doesn't give us:
//   - A missing secret must never authorize anyone. `undefined === undefined`
//     is true, so an environment that forgot to set CRAWL_SECRET would have
//     opened every ingest route to a request that also sent nothing.
//   - Comparison time must not depend on how much of the secret is right.

import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'

export function secretMatches(supplied: string | null | undefined, expected: string | undefined): boolean {
  if (!expected || !supplied) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length — compare against a same-length buffer and fold the result in.
  if (a.length !== b.length) {
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

/**
 * The gate in front of every crawl/ingest route — they spend embedding credits,
 * rewrite the knowledge base, and take minutes to run.
 *
 * Vercel's scheduler is recognised by the `Authorization: Bearer $CRON_SECRET`
 * header it sends when CRON_SECRET is set, which is the check Vercel documents.
 * The bare `x-vercel-cron` header is accepted only as a fallback for projects
 * that haven't set CRON_SECRET yet, because a header is a claim, not a proof.
 */
export function isCrawlAuthorized(req: Request): boolean {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer /i, '')
  if (secretMatches(bearer, process.env.CRON_SECRET)) return true
  if (secretMatches(bearer, process.env.CRAWL_SECRET)) return true

  const url = new URL(req.url)
  if (secretMatches(url.searchParams.get('secret'), process.env.CRAWL_SECRET)) return true

  if (!process.env.CRON_SECRET && req.headers.get('x-vercel-cron') === '1') return true
  return false
}

/* The 401 body, which used to be the word "Unauthorized" and nothing else.
 *
 * These routes are driven by hand from a terminal, and that word cost two round
 * trips on one task: it does not say which header, which secret, or — the actual
 * problem both times — whether the secret is configured on the deployment at all.
 * An unset shell variable expands to nothing, `Authorization: Bearer ` supplies an
 * empty secret, and secretMatches correctly refuses it. Identical symptom, three
 * different causes.
 *
 * Note the asymmetry it now spells out, which is easy to hit and was invisible: the
 * bearer header is accepted against either secret, but `?secret=` is only ever
 * checked against CRAWL_SECRET. A deployment with only CRON_SECRET set can never be
 * reached by the query-string form, however correct the value.
 *
 * Which secrets exist is reported; no value ever is. That is a deliberate trade:
 * knowing CRAWL_SECRET is unset tells an unauthenticated caller only that one form
 * is unusable, and it is exactly the fact an operator needs to fix their own app —
 * which is worth more here than withholding it.
 */
export function unauthorized(): NextResponse {
  const configured = [
    process.env.CRON_SECRET ? 'CRON_SECRET set' : 'CRON_SECRET unset',
    process.env.CRAWL_SECRET ? 'CRAWL_SECRET set' : 'CRAWL_SECRET unset',
  ].join(', ')
  return NextResponse.json({
    error: 'Unauthorized',
    accepted: [
      'Authorization: Bearer <CRON_SECRET or CRAWL_SECRET>',
      '?secret=<CRAWL_SECRET>  (this form does NOT accept CRON_SECRET)',
    ],
    configured,
    hint: 'An unset shell variable sends an empty secret, which is refused — check `echo ${#CRAWL_SECRET}` is not 0.',
  }, { status: 401 })
}
