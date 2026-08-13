// Shared plumbing for the verification scripts: reading credentials, talking to
// the corpus, and asking the app a question without tripping its rate limiter.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** Values from .env.local. Never printed — only passed as headers. */
export function loadEnv() {
  const file = path.join(ROOT, '.env.local')
  if (!fs.existsSync(file)) throw new Error(`no .env.local at ${file}`)
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(l => l.includes('=') && !l.trimStart().startsWith('#'))
      .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')])
  )
}

/* Read-only corpus access over PostgREST.
 *
 * Two rules learned the hard way, both of which have produced confidently wrong
 * conclusions in this project before:
 *
 *   - The row cap is real and silent. A request with no explicit limit returns
 *     at most 1000 rows and looks exactly like a complete answer, so `select`
 *     here always pages rather than trusting a single response.
 *   - Alternates need or=(a,b), not a comma inside one filter. The comma form
 *     returns an HTML error page, which then fails to parse as JSON somewhere
 *     far away from the mistake.
 */
export function corpus(env) {
  const U = env.NEXT_PUBLIC_SUPABASE_URL
  const K = env.SUPABASE_SERVICE_ROLE_KEY
  if (!U || !K) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env.local')
  const headers = { apikey: K, Authorization: `Bearer ${K}` }

  async function page(table, query, offset, limit) {
    const res = await fetch(`${U}/rest/v1/${table}?${query}&offset=${offset}&limit=${limit}`, { headers })
    const body = await res.text()
    if (!res.ok) throw new Error(`${table} ${res.status}: ${body.slice(0, 200)}`)
    try { return JSON.parse(body) } catch { throw new Error(`${table}: non-JSON response: ${body.slice(0, 200)}`) }
  }

  return {
    /** Every matching row, paged past the 1000-row cap. */
    async selectAll(table, query, { pageSize = 1000, max = 20000 } = {}) {
      const out = []
      for (let off = 0; off < max; off += pageSize) {
        const rows = await page(table, query, off, pageSize)
        out.push(...rows)
        if (rows.length < pageSize) break
      }
      return out
    },
    async select(table, query, limit = 100) {
      return page(table, query, 0, limit)
    },
  }
}

/* /api/search allows 20 requests a minute (rate-limit name 'search' in
 * src/app/api/search/route.ts). The first version of check-answers.mjs did not
 * pace itself, collected 429s, and reported them as wrong answers — a harness
 * that invents bugs is worse than no harness. 3.8s leaves headroom under the
 * limit without making a run painfully slow. */
export const PACE_MS = 3800
export const RATE_LIMITED = '__RATE_LIMITED__'

const sleep = ms => new Promise(r => setTimeout(r, ms))
let lastCall = 0

/**
 * Ask the app a question and return its answer text.
 *
 * Always sends debug:true, which bypasses the answer cache (see `cacheable` in
 * the search route). That costs real tokens per call, and it is the point: a
 * cached answer would tell us what the app said once, not what it says now.
 */
export async function ask(base, query, { history = [] } = {}) {
  const wait = PACE_MS - (Date.now() - lastCall)
  if (wait > 0) await sleep(wait)
  lastCall = Date.now()

  let res
  try {
    res = await fetch(`${base}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, history, debug: true }),
      signal: AbortSignal.timeout(90_000),
    })
  } catch (e) {
    return { answer: '', error: e instanceof Error ? e.message : String(e) }
  }
  if (res.status === 429) return { answer: RATE_LIMITED, error: 'rate limited' }
  if (!res.ok) return { answer: '', error: `HTTP ${res.status}` }

  let answer = ''
  const sources = []
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'text') answer += event.text
    if (event.type === 'sources') sources.push(...(event.sources ?? []))
  }
  return { answer: answer.replace(/\s+/g, ' ').trim(), sources, cache: res.headers.get('x-tca-cache') }
}

/* Published per-million rates, only for turning logged token counts into a
 * dollar figure at the end of a run.
 *
 * Read from the same src/lib/model-rates.json the app's own pricing imports,
 * rather than kept as a copy here. There were three tables — this one and one
 * in each of /api/admin/stats and /api/admin/queries — and they disagreed:
 * two priced Sonnet 5 differently, none knew about GPT-5.4 nano, and all three
 * fell back to Haiku for anything unrecognised, so nano runs were reported at
 * roughly five times what they cost. JSON because this file is .mjs and cannot
 * import the TypeScript module. */
const RATES = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src/lib/model-rates.json'), 'utf8')
)

/**
 * What a run actually cost, read from query_log rather than estimated.
 *
 * Cache hits log zero tokens, so they contribute nothing, which is correct.
 * Cache *creation* and *read* tokens are billed though, at 1.25x and 0.1x the
 * input rate, and are counted here — leaving them out understated every cached
 * request. `unpriced` counts rows whose model has no published rate: a visible
 * gap, rather than a total that silently drops them or charges a neighbour's
 * price, which is the bug this replaced.
 */
export async function costSince(db, sinceISO) {
  const rows = await db.selectAll(
    'query_log',
    `created_at=gte.${sinceISO}&select=model,input_tokens,output_tokens,` +
      `cache_creation_input_tokens,cache_read_input_tokens,cache_hit`
  )
  let usd = 0, tokensIn = 0, tokensOut = 0, unpriced = 0
  for (const r of rows) {
    tokensIn += r.input_tokens ?? 0
    tokensOut += r.output_tokens ?? 0
    // '-failed' rows log no tokens, but strip the suffix anyway so a partially
    // billed failure prices correctly instead of falling through as unknown.
    const p = RATES.models[String(r.model ?? '').replace(/-failed$/, '')]
    if (!p) {
      if (r.input_tokens != null || r.output_tokens != null) unpriced++
      continue
    }
    usd +=
      ((r.input_tokens ?? 0) * p.input +
        (r.cache_creation_input_tokens ?? 0) * p.input * RATES.cacheWriteMultiplier +
        (r.cache_read_input_tokens ?? 0) * p.input * RATES.cacheReadMultiplier +
        (r.output_tokens ?? 0) * p.output) / 1e6
  }
  return { queries: rows.length, tokensIn, tokensOut, usd, unpriced }
}
