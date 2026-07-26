// Comparing the shared secrets that stand in front of the crawl routes and the
// analytics dashboard.
//
// Two properties that `a === b` doesn't give us:
//   - A missing secret must never authorize anyone. `undefined === undefined`
//     is true, so an environment that forgot to set CRAWL_SECRET would have
//     opened every ingest route to a request that also sent nothing.
//   - Comparison time must not depend on how much of the secret is right.

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
