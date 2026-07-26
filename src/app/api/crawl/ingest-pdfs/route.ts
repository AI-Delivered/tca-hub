import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'
import { isCrawlAuthorized } from '@/lib/auth'

export const maxDuration = 300

function chunkText(text: string, chunkSize = 1800, overlap = 200): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    chunks.push(text.slice(start, start + chunkSize))
    start += chunkSize - overlap
  }
  return chunks
}

// Finds all /fs/resource-manager/view/ links from indexed pages and extracts them as PDFs via Claude
export async function POST(req: NextRequest) {
  if (!isCrawlAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { VoyageAIClient } = await import('voyageai')
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const supabase = getSupabaseAdmin()

  // Discovery re-fetches the indexed pages and reads the document links out of
  // their HTML. It used to grep indexed chunk *text* for resource-manager URLs,
  // but the crawler stores plain text with hrefs stripped — so it matched nothing
  // on every run and no new PDF had been picked up since the corpus was seeded by
  // scripts/run-ingest-pdfs.mjs. Newsletters and supply lists are posted this way,
  // so silently discovering zero is the difference between having them and not.
  const MAX_PAGES = 150
  const FETCH_CONCURRENCY = 8

  const { data: pageRows } = await supabase
    .from('page_chunks')
    .select('url')
    .ilike('url', 'https://www.tcatitans.org/%')
    .limit(2000)
  const pages = [...new Set((pageRows ?? []).map(r => r.url.split('#')[0]))]
    .filter(u => !u.includes('/fs/resource-manager/'))
    .slice(0, MAX_PAGES)

  // url -> the link's anchor text, which is what the document is actually called
  // ("2026-27 Supply List") as opposed to the UUID in its URL.
  const discovered = new Map<string, string>()
  const linkRe = /<a[^>]+href=["']([^"']*\/fs\/resource-manager\/view\/[a-f0-9-]+)["'][^>]*>([\s\S]*?)<\/a>/gi
  for (let i = 0; i < pages.length; i += FETCH_CONCURRENCY) {
    await Promise.all(pages.slice(i, i + FETCH_CONCURRENCY).map(async page => {
      try {
        const res = await fetch(page, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TCAHub/1.0)' },
          signal: AbortSignal.timeout(10000),
        })
        if (!res.ok) return
        const html = await res.text()
        for (const m of html.matchAll(linkRe)) {
          const href = m[1].startsWith('http') ? m[1] : `https://www.tcatitans.org${m[1]}`
          const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
          if (!discovered.get(href)) discovered.set(href, text)
        }
      } catch { /* page unavailable this run — the next one will catch it */ }
    }))
  }

  // Get already-indexed URLs to skip
  const { data: indexedRows } = await supabase.from('page_chunks').select('url').ilike('url', '%resource-manager%')
  const indexedUrls = new Set((indexedRows ?? []).map(r => r.url))

  const urls = [...discovered.keys()].filter(u => !indexedUrls.has(u)).slice(0, 20)
  let indexed = 0, skipped = 0, errors = 0

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TCAHub/1.0)' },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) { skipped++; continue }

      const contentType = res.headers.get('content-type') ?? ''
      const buffer = await res.arrayBuffer()
      const base64 = Buffer.from(buffer).toString('base64')

      let content = ''

      if (contentType.includes('pdf') || url.endsWith('.pdf')) {
        // Use Claude to extract text from PDF
        const msg = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2048,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: base64 },
              },
              {
                type: 'text',
                text: 'Extract all text content from this TCA school document. Include all dates, times, names, grades, events, deadlines, and details. Output as plain structured text.',
              },
            ],
          }],
        })
        content = msg.content[0].type === 'text' ? msg.content[0].text : ''
      } else {
        // Plain text / HTML fallback
        content = Buffer.from(buffer).toString('utf-8')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      }

      if (!content || content.length < 100) { skipped++; continue }

      const title = url.split('/').pop() ?? url
      await supabase.from('page_chunks').delete().eq('url', url)

      const chunks = chunkText(content)
      const embRes = await voyage.embed({
        input: chunks.map(c => c.slice(0, 16000)),
        model: 'voyage-3-lite',
      })

      for (let i = 0; i < chunks.length; i++) {
        const embedding = embRes.data?.[i]?.embedding
        if (!embedding) continue
        const { error } = await supabase.from('page_chunks').insert({ url, title, content: chunks[i], embedding })
        if (error) errors++; else indexed++
      }
    } catch {
      errors++
    }
  }

  return NextResponse.json({ total: urls.length, indexed, skipped, errors })
}

export async function GET(req: NextRequest) {
  if (!isCrawlAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return POST(req)
}
