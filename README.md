# TCA Hub

Ask a question about The Classical Academy in Colorado Springs — bell schedules,
staff, athletics, calendars, dress code, supply lists — and get a straight answer
with the pages it came from.

Next.js App Router on Vercel. Content is scraped from tcatitans.org and a handful
of calendar feeds into Supabase, retrieved with Voyage embeddings, and answered
by Claude.

## Running it

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env.local` and fill it in. `ADMIN_PASSWORD` is required
for the `/nerds` dashboard — unset, the analytics API returns 503 rather than
falling back to a default password.

```bash
npm run build     # production build
npm run lint      # eslint
npm test          # markdown sanitizer cases (scripts/test-markdown.mjs)
```

## How a question is answered

`src/app/api/search/route.ts` is the whole path:

1. **Cache.** Standalone questions are keyed on their canonical form
   (`src/lib/query-key.ts`) plus today's date and the deployment id. A hit skips
   the embedding, the retrieval and the generation.
2. **Retrieval.** The question is embedded with `voyage-3-lite` and matched
   against `page_chunks` via the `match_chunks` RPC, then supplemented with
   keyword anchors — staff by name and by role, calendar months, per-sport
   schedules — because near-identical chunks compete for the top-16 slots.
3. **Trimming.** Chunks are cut down to the part that can answer the question
   before they reach the model. `scripts/measure-context.mjs` asserts the
   answer-bearing facts survive each trim.
4. **Generation.** Haiku by default; Sonnet when retrieval scored poorly or the
   thread is long. Streamed to the browser as NDJSON, with staff photo cards
   pushed as soon as the answer names somebody.

If the model can't be reached, staff questions are still answered directly from
the retrieved rows rather than apologising.

## Security

- **Model output is never trusted HTML.** `src/lib/markdown.ts` configures
  marked so it cannot emit raw HTML, validates every link protocol, and escapes
  every attribute; DOMPurify runs over the result as a second, lazily-loaded
  pass. `npm test` proves the cases.
- **The public endpoints are rate limited** (`src/lib/rate-limit.ts`) —
  `/api/search` spends money per call, `/api/track-visit` writes a row per call.
- **Request bodies are bounded.** Question length, conversation length and each
  turn's size are all capped before anything reaches the model.
- **Secrets are compared in constant time** and a missing secret authorizes
  nobody (`src/lib/auth.ts`).
- **Security headers, including a CSP**, are set in `next.config.ts`.
- **Row level security** is enabled on every table by
  `supabase/migrations/006_enable_rls.sql`. The app uses the service role, which
  bypasses RLS; anything reading from the browser needs its own explicit policy.

## Scheduled ingestion

`vercel.json` runs the crawl and ingest routes on a schedule. Set `CRON_SECRET`
in Vercel and the scheduler sends it as a bearer token, which is what the routes
verify; without it they fall back to trusting the `x-vercel-cron` header.

To run one by hand:

```bash
curl -H "Authorization: Bearer $CRAWL_SECRET" https://tca-hub.vercel.app/api/crawl/ingest-staff
```

## Dashboard

`/nerds` — query volume, questions that came back empty or thin, cost per model,
site visits, and a copyable prompt per failing question. Gated by
`ADMIN_PASSWORD`, sent as an `x-admin-key` header.
