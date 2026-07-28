// Reading a complete list of urls out of page_chunks.
//
// PostgREST answers with at most 1,000 rows however large a `limit` you ask for,
// and says nothing about having truncated. That default has now broken three
// separate things in this app: page discovery in ingest-pdfs silently shrank as
// the route succeeded, its already-indexed check was heading for the same cliff
// and would have re-paid Claude for 60% of the corpus weekly, and the crawler's
// stale-page cleanup would quietly stop seeing older pages.
//
// The pattern is always the same and always looks fine until the table grows
// past the cap, so it lives here once instead of being rewritten per route.
// A short page is the end of the data; a full page never is.

const PAGE_SIZE = 1000

/**
 * Pages through a url query until it is exhausted.
 *
 * The caller supplies the filters and receives a range, because the filters
 * differ per route and only the paging is common.
 */
export async function fetchAllUrls(
  query: (from: number, to: number) => PromiseLike<{ data: { url: string }[] | null }>
): Promise<string[]> {
  const urls: string[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data } = await query(from, from + PAGE_SIZE - 1)
    const rows = data ?? []
    for (const row of rows) urls.push(row.url)
    if (rows.length < PAGE_SIZE) return urls
  }
}
