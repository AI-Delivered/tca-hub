#!/usr/bin/env node
// Re-extract the documents that were stored as decoded binary.
//
// ingest-pdfs sends PDFs to Claude and falls back to a UTF-8 decode for
// everything else. TCA's resource manager also serves Word documents, and a
// .docx is a ZIP — decoding one as UTF-8 produced mojibake that passed the only
// guard in place (a length check) and was chunked and embedded as prose.
// Measured: 215 of 2,295 chunks, 9.4% of the corpus, across 14 documents —
// the High School Science and Math supply lists, the Seizure and Diabetes care
// plans, 6th Grade Grading Expectations, Concert Attire. Each was at once
// unanswerable and occupying an embedding retrieval could return.
//
// src/lib/looks-binary.ts now stops the ingest storing them again. This repairs
// what is already there, using @firecrawl/anydoc — a local Rust library that
// reads .doc/.docx/.xlsx natively in about a millisecond, with no API cost.
//
// Run locally; anydoc is a devDependency and is deliberately not on the
// serverless path, where bundling a native module is an unproven risk.
//
//   node scripts/fix-binary-documents.mjs --dry     # list what would change
//   node scripts/fix-binary-documents.mjs

import { toMarkdownBytes } from '@firecrawl/anydoc'
import { loadEnv, corpus } from './lib/ask.mjs'

const DRY = process.argv.includes('--dry')
const env = loadEnv()
const db = corpus(env)

const U = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

/* Kept in step with src/lib/looks-binary.ts. Duplicated rather than imported
 * because that file is TypeScript inside the Next build and this is a plain
 * node script; if one changes, change both. */
const CONTAINER_MARKERS = /\bPK|word\/document\.xml|xl\/worksheets\/|ppt\/slides\/|\[Content_Types\]\.xml/
const looksBinary = t =>
  Boolean(t) && (CONTAINER_MARKERS.test(t) || (t.match(/�/g) ?? []).length / t.length > 0.02)

// Same domain correction the ingest applies — staff moved off @asd20.org.
const fixDomain = s => s.replace(/\b([\w.+-]+)\s?@asd20\.org\b/gi, (_m, local) => `${local}@tcatitans.org`)

// Same chunking as ingest-pdfs, so repaired documents match everything else.
function chunkText(text, chunkSize = 1800, overlap = 200) {
  const out = []
  for (let start = 0; start < text.length; start += chunkSize - overlap) {
    out.push(text.slice(start, start + chunkSize))
  }
  return out
}

const rows = await db.selectAll('page_chunks', 'select=url,title,content')
const broken = new Map()
for (const r of rows) {
  if (!looksBinary(r.content ?? '')) continue
  const e = broken.get(r.url) ?? { title: r.title, chunks: 0 }
  e.chunks++
  broken.set(r.url, e)
}

console.log(`corpus: ${rows.length} chunks, ${[...broken.values()].reduce((n, e) => n + e.chunks, 0)} binary across ${broken.size} documents\n`)
if (!broken.size) { console.log('nothing to repair'); process.exit(0) }

if (DRY) {
  for (const [url, e] of broken) console.log(`  ${String(e.chunks).padStart(3)} chunks  ${(e.title ?? '').slice(0, 46).padEnd(46)} ${url.slice(0, 60)}`)
  console.log('\n--dry: nothing written')
  process.exit(0)
}

const { VoyageAIClient } = await import('voyageai')
const voyage = new VoyageAIClient({ apiKey: env.VOYAGE_API_KEY })

let repaired = 0, failed = 0, removed = 0
for (const [url, e] of broken) {
  const label = (e.title ?? url).slice(0, 44)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TCAHub/1.0)' },
      signal: AbortSignal.timeout(45000),
    })
    if (!res.ok) { console.log(`SKIP  ${label} — HTTP ${res.status}`); failed++; continue }

    const text = fixDomain(await toMarkdownBytes(new Uint8Array(await res.arrayBuffer())))

    /* Only replace with something demonstrably better. A short or still-binary
     * extraction would trade one bad state for another, so the old rows are
     * deleted either way — a document that cannot be read should be absent,
     * not present as noise. */
    const usable = text && text.length >= 100 && !looksBinary(text)

    await fetch(`${U}/rest/v1/page_chunks?url=eq.${encodeURIComponent(url)}`, { method: 'DELETE', headers: H })

    if (!usable) {
      console.log(`PURGE ${label} — extraction unusable (${text?.length ?? 0} chars), removed ${e.chunks} bad chunks`)
      removed += e.chunks
      continue
    }

    const chunks = chunkText(text)
    const emb = await voyage.embed({ input: chunks.map(c => c.slice(0, 16000)), model: 'voyage-3-lite' })
    const payload = chunks.map((content, i) => ({
      url, title: e.title, content, embedding: emb.data[i].embedding, crawled_at: new Date().toISOString(),
    }))
    const ins = await fetch(`${U}/rest/v1/page_chunks`, {
      method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(payload),
    })
    const stored = await ins.json()
    console.log(`ok    ${label.padEnd(46)} ${e.chunks} bad → ${Array.isArray(stored) ? stored.length : 0} clean (${text.length} chars)`)
    repaired++
  } catch (err) {
    /* Extraction failed, but these rows are already known to be binary — the
     * scan above is what selected them. Removing them is correct regardless of
     * whether a replacement could be produced, and a later ingest run will
     * re-fetch anything that is genuinely a document. The case that lands here
     * is usually something that never was one: the first run hit a JavaScript
     * bundle from /assets/, which anydoc rightly refused to parse. */
    console.log(`ERROR ${label || url.slice(0, 44)} — ${(err?.message ?? err).toString().slice(0, 60)}; removing ${e.chunks} bad chunks`)
    await fetch(`${U}/rest/v1/page_chunks?url=eq.${encodeURIComponent(url)}`, { method: 'DELETE', headers: H })
    removed += e.chunks
    failed++
  }
}

console.log(`\nrepaired ${repaired}, purged ${removed} unusable chunks, failed ${failed}`)
