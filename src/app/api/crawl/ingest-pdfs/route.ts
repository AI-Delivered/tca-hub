import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export const maxDuration = 300

function isAuthorized(req: NextRequest): boolean {
  if (req.headers.get('x-vercel-cron') === '1') return true
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret === process.env.CRAWL_SECRET) return true
  return req.headers.get('authorization') === `Bearer ${process.env.CRAWL_SECRET}`
}

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
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { VoyageAIClient } = await import('voyageai')
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const supabase = getSupabaseAdmin()

  // Pull all resource-manager URLs referenced in indexed content
  const { data: rows } = await supabase
    .from('page_chunks')
    .select('content')
    .ilike('content', '%resource-manager/view/%')

  const urlSet = new Set<string>()
  for (const row of rows ?? []) {
    const matches = row.content.match(/https:\/\/www\.tcatitans\.org\/fs\/resource-manager\/view\/[a-f0-9-]+/g) ?? []
    matches.forEach((u: string) => urlSet.add(u))
  }

  // Get already-indexed URLs to skip
  const { data: indexedRows } = await supabase.from('page_chunks').select('url').ilike('url', '%resource-manager%')
  const indexedUrls = new Set((indexedRows ?? []).map(r => r.url))

  const urls = [...urlSet].filter(u => !indexedUrls.has(u)).slice(0, 20)
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
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return POST(req)
}
