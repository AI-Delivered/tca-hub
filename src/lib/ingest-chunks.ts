// Storing a scraped document so that all of it is findable.
//
// The bug this exists to fix: several ingest routes wrote one row per feed and
// embedded `content.slice(0, 16_000)`. The full text was stored, but the
// embedding — the vector that decides whether this row matches a question — was
// computed from the first 16,000 characters only. Anything past that was in the
// database and invisible to search.
//
// It was not a theoretical limit. "TCA HS Football — Practices & Training" is
// 111,838 characters, so 86% of the football practice schedule could not be
// retrieved, which is a good part of why athletics questions kept coming back
// as thin matches. The routes that already call chunkText (ingest-deep,
// ingest-pdfs, ingest-visual) never had the problem.
//
// Long content is split, every piece gets its own embedding, and each is stored
// as its own row under the same URL — exactly what those routes already do.

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeContent } from '@/lib/normalize-content'

/** Matches the chunking used by ingest-deep / ingest-pdfs / ingest-visual. */
const CHUNK_SIZE = 1800
const CHUNK_OVERLAP = 200

// voyage-3-lite accepts a list per call, but not an unbounded one, and a
// 110k-character feed is ~70 pieces. Batched so one long feed can't exceed
// whatever the provider's per-request ceiling happens to be.
const EMBED_BATCH = 96

// Voyage's own per-input token ceiling. Chunks are 1,800 characters so this
// never actually bites; it is here so a caller passing pre-chunked oversized
// text still can't produce a rejected request.
const EMBED_INPUT_CHARS = 16_000

/**
 * Strips the two character classes Postgres refuses to store in a text column.
 *
 * Found the hard way: a PDF ingest run logged 147 failed inserts, and the count
 * was *identical* on eight consecutive rounds. Identical is the tell — the same
 * documents were failing the same way every time, never getting indexed, and so
 * never leaving the queue. Each round re-fetched them, re-paid Claude to extract
 * them, and re-failed, which is also why the backlog never converged.
 *
 *   U+0000            → "unsupported Unicode escape sequence"
 *   lone surrogate    → "Empty or invalid json"
 *
 * Both come out of PDF text extraction routinely. Replaced with a space rather
 * than removed so word boundaries survive.
 */
export function sanitizeForPostgres(text: string): string {
  return text
    .replace(/\u0000/g, ' ')
    // Unpaired halves of a surrogate pair — a paired one is a valid character
    // and is left alone by these two patterns.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, ' ')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, ' ')
}

export function chunkText(text: string, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    chunks.push(text.slice(start, start + chunkSize))
    start += chunkSize - overlap
  }
  return chunks
}

interface VoyageLike {
  embed(args: { input: string[]; model: string }): Promise<{ data?: ({ embedding?: number[] } | undefined)[] }>
}

export interface ChunkRecord {
  url: string
  title: string
  content: string
  /** Any extra columns the calling route sets on its rows. */
  extra?: Record<string, unknown>
}

export interface StoreResult {
  inserted: number
  chunks: number
  errors: number
}

/**
 * Chunks `content`, embeds every piece, and writes one row per piece.
 *
 * Does NOT delete first — callers already clear their own URL range before
 * re-ingesting, and the delete patterns differ per route.
 */
export async function storeChunks(
  supabase: SupabaseClient,
  voyage: VoyageLike,
  record: ChunkRecord,
  crawledAt: string
): Promise<StoreResult> {
  const pieces = chunkText(normalizeContent(sanitizeForPostgres(record.content)))
  let inserted = 0
  let errors = 0

  for (let i = 0; i < pieces.length; i += EMBED_BATCH) {
    const batch = pieces.slice(i, i + EMBED_BATCH)

    let embeddings: ({ embedding?: number[] } | undefined)[]
    try {
      const res = await voyage.embed({
        input: batch.map(c => c.slice(0, EMBED_INPUT_CHARS)),
        model: 'voyage-3-lite',
      })
      embeddings = res.data ?? []
    } catch {
      // One failed batch shouldn't cost the rest of the document.
      errors += batch.length
      continue
    }

    for (let j = 0; j < batch.length; j++) {
      const embedding = embeddings[j]?.embedding
      if (!embedding) { errors++; continue }
      const { error } = await supabase.from('page_chunks').insert({
        url: record.url,
        title: record.title,
        content: batch[j],
        embedding,
        crawled_at: crawledAt,
        ...record.extra,
      })
      // Logged, not just counted. A bare counter is what let 147 identical
      // failures repeat for eight rounds without anyone knowing what they were.
      if (error) {
        errors++
        if (errors <= 3) console.error(`page_chunks insert failed for ${record.url}: ${error.message}`)
      } else {
        inserted++
      }
    }
  }

  return { inserted, chunks: pieces.length, errors }
}
