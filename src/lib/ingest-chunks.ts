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

/**
 * Splits on line boundaries where it can, and only mid-line when a single line
 * is longer than a chunk.
 *
 * This used to slice at exact character offsets, which is fine for prose and
 * quietly destructive for the schedule documents that make up most of the
 * corpus. Every event is one line, so a cut landed mid-event and the 200-char
 * overlap then pasted the tail of one event onto the head of another. The girls
 * flag football schedule contained, among 92 lines, seven fragments like:
 *
 *   [Girls Flag Football Varsity (Girls)] Mon, Sep 14, 2026, 3:30 PM–5:30ep 10, 2026, 7:00
 *
 * — a date, a time that belongs to a different game, and an opponent from a
 * third. That is the raw material for a confidently wrong answer about when a
 * game is, which is the failure this corpus can least afford: nobody checks a
 * plausible time, they drive to it.
 *
 * Overlap is carried as whole trailing lines rather than a character count, so
 * the seam between two chunks is always a real event and never half of two.
 */
export function chunkText(text: string, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  // No newlines to split on — prose, or a single long line. Behaves as before.
  if (!text.includes('\n')) {
    if (text.length <= chunkSize) return text.length ? [text] : []
    const out: string[] = []
    for (let start = 0; start < text.length; start += chunkSize - overlap) {
      out.push(text.slice(start, start + chunkSize))
    }
    return out
  }

  const lines = text.split('\n')
  const chunks: string[] = []
  let current: string[] = []
  let size = 0

  const flush = () => {
    if (!current.length) return
    chunks.push(current.join('\n'))
    // Re-open the next chunk with the last whole lines, up to the overlap
    // budget, so a fact split across the seam is readable from both sides.
    const carried: string[] = []
    let carriedSize = 0
    for (let i = current.length - 1; i >= 0; i--) {
      if (carriedSize + current[i].length + 1 > overlap) break
      carried.unshift(current[i])
      carriedSize += current[i].length + 1
    }
    current = carried
    size = carriedSize
  }

  for (const line of lines) {
    // A single line longer than a chunk has to be broken; give it its own
    // chunks rather than dragging a neighbour's text along with it.
    if (line.length + 1 > chunkSize) {
      flush()
      if (current.length) { chunks.push(current.join('\n')); current = []; size = 0 }
      for (let start = 0; start < line.length; start += chunkSize - overlap) {
        chunks.push(line.slice(start, start + chunkSize))
      }
      continue
    }
    if (size + line.length + 1 > chunkSize) flush()
    current.push(line)
    size += line.length + 1
  }
  if (current.length) chunks.push(current.join('\n'))

  // Trailing overlap-only chunks add nothing: their every line already appeared
  // in full in the chunk before them.
  return chunks.filter((c, i) => i === 0 || !chunks[i - 1].includes(c))
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
