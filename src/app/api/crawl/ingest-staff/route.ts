import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export const maxDuration = 300

function isAuthorized(req: NextRequest): boolean {
  if (req.headers.get('x-vercel-cron') === '1') return true
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

const STAFF_DIRECTORY_URL = 'https://www.tcatitans.org/about/staff-directory'

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { VoyageAIClient } = await import('voyageai')
  const { default: FirecrawlApp } = await import('@mendable/firecrawl-js')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY })
  const supabase = getSupabaseAdmin()

  // Scrape the staff directory page with JS actions to load all staff cards
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (firecrawl.scrapeUrl as any)(STAFF_DIRECTORY_URL, {
    formats: ['markdown', 'html'],
    actions: [
      { type: 'wait', milliseconds: 2000 },
      // Click every staff card to reveal contact modals, then wait for content
      { type: 'click', selector: '.fsl-staff-card' },
      { type: 'wait', milliseconds: 1000 },
    ],
    waitFor: 3000,
  })

  const rawMarkdown: string = result?.markdown ?? ''
  const rawHtml: string = result?.html ?? ''

  // Extract staff info from HTML: look for email links and names near them
  const staffEntries: string[] = []

  // Parse email links from the HTML
  const emailMatches = rawHtml.matchAll(/href="mailto:([^"]+)"[^>]*>([^<]*)<\/a>/gi)
  const nameEmailMap = new Map<string, string>()
  for (const match of emailMatches) {
    const email = match[1].trim()
    const linkText = match[2].trim()
    if (email.endsWith('@tcatitans.org') && linkText) {
      nameEmailMap.set(linkText, email)
    }
  }

  // Also pull name+email pairs from the HTML with broader patterns
  const staffCardMatches = rawHtml.matchAll(
    /<(?:h[1-6]|strong|b)[^>]*>([^<]{3,60})<\/(?:h[1-6]|strong|b)>[^]*?href="mailto:([^"@]+@tcatitans\.org)"/gi
  )
  for (const match of staffCardMatches) {
    nameEmailMap.set(match[1].trim(), match[2].trim())
  }

  if (nameEmailMap.size > 0) {
    const lines = ['# TCA Staff Directory', '']
    for (const [name, email] of nameEmailMap) {
      lines.push(`- **${name}**: ${email}`)
      staffEntries.push(`${name}: ${email}`)
    }
    const staffContent = lines.join('\n')

    // Delete old staff directory chunks and re-index
    await supabase.from('page_chunks').delete().eq('url', STAFF_DIRECTORY_URL)

    const chunks = chunkText(staffContent)
    const embeddingRes = await voyage.embed({
      input: chunks.map(c => c.slice(0, 16000)),
      model: 'voyage-3-lite',
    })

    let indexed = 0
    for (let i = 0; i < chunks.length; i++) {
      const embedding = embeddingRes.data?.[i]?.embedding
      if (!embedding) continue
      const { error } = await supabase.from('page_chunks').insert({
        url: STAFF_DIRECTORY_URL,
        title: 'TCA Staff Directory',
        content: chunks[i],
        embedding,
      })
      if (!error) indexed++
    }

    return NextResponse.json({
      success: true,
      staffFound: nameEmailMap.size,
      indexed,
      sample: staffEntries.slice(0, 5),
    })
  }

  // Fallback: index whatever markdown we got, even if we didn't parse emails
  if (rawMarkdown.length > 100) {
    await supabase.from('page_chunks').delete().eq('url', STAFF_DIRECTORY_URL)
    const chunks = chunkText(rawMarkdown)
    const embeddingRes = await voyage.embed({
      input: chunks.map(c => c.slice(0, 16000)),
      model: 'voyage-3-lite',
    })
    let indexed = 0
    for (let i = 0; i < chunks.length; i++) {
      const embedding = embeddingRes.data?.[i]?.embedding
      if (!embedding) continue
      const { error } = await supabase.from('page_chunks').insert({
        url: STAFF_DIRECTORY_URL,
        title: 'TCA Staff Directory',
        content: chunks[i],
        embedding,
      })
      if (!error) indexed++
    }
    return NextResponse.json({
      success: true,
      staffFound: 0,
      indexed,
      note: 'No structured emails found — indexed raw markdown as fallback',
      preview: rawMarkdown.slice(0, 500),
    })
  }

  return NextResponse.json({
    success: false,
    note: 'Staff directory returned no usable content',
    htmlLength: rawHtml.length,
    markdownLength: rawMarkdown.length,
  })
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return POST(req)
}
