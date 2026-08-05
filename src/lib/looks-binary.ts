// Is this "text" actually decoded binary?
//
// ingest-pdfs extracts PDFs through Claude, and falls back to a plain UTF-8
// decode for everything else. TCA's resource manager also serves Word
// documents, and a .docx is a ZIP archive — decoding one as UTF-8 produces
// thousands of replacement characters, which sailed past the only guard in
// place (a length check) and got chunked and embedded like prose.
//
// Measured before this existed: 215 of 2,295 chunks — 9.4% of the corpus —
// were raw OOXML bytes, across 14 documents including the High School Science
// and Math supply lists, the Seizure and Diabetes care plans, and 6th Grade
// Grading Expectations. Each one was simultaneously unanswerable and occupying
// an embedding that retrieval could return.

/** Fragments of the ZIP/OOXML container that no school document would contain. */
const CONTAINER_MARKERS = /\bPK|word\/document\.xml|xl\/worksheets\/|ppt\/slides\/|\[Content_Types\]\.xml/

/**
 * True when `text` is decoded binary rather than readable prose.
 *
 * Two independent signals, so a document is not condemned by one alone: the
 * U+FFFD replacement character (which only appears when a decode failed) above
 * a rate no real text reaches, or an explicit archive marker.
 */
export function looksBinary(text: string): boolean {
  if (!text) return false
  if (CONTAINER_MARKERS.test(text)) return true

  /* 2% is far above what legitimate text produces — a page with a handful of
   * mis-encoded curly quotes sits near zero — and far below the ~40-50%
   * measured on the affected documents. */
  const replacements = (text.match(/�/g) ?? []).length
  return replacements / text.length > 0.02
}
