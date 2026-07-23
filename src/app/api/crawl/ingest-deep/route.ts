import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export const maxDuration = 300

// Curated pages that are important but may not surface in the main BFS crawl
const SEED_PAGES = [
  { url: 'https://www.tcatitans.org/schools/junior-high/seventh-grade/class-of-2030-welcome-to-junior-high', title: 'TCA Junior High — Welcome to 7th Grade' },
  { url: 'https://www.tcatitans.org/schools/high-school/academics/graduation-requirements', title: 'TCA High School Graduation Requirements' },
  { url: 'https://www.tcatitans.org/schools/high-school/student-life/clubs-activities', title: 'TCA High School Clubs & Activities' },
  { url: 'https://www.tcatitans.org/schools/junior-high/student-life', title: 'TCA Junior High Student Life' },
  { url: 'https://www.tcatitans.org/family/transportation', title: 'TCA Transportation & Busing' },
  { url: 'https://www.tcatitans.org/family/health-services', title: 'TCA Health Services' },
  { url: 'https://www.tcatitans.org/family/volunteer', title: 'TCA Volunteering' },
  { url: 'https://www.tcatitans.org/about/mission-vision', title: 'TCA Mission & Vision' },
  { url: 'https://www.tcatitans.org/schools/college-pathways/programs', title: 'TCA College Pathways Programs' },
  { url: 'https://www.tcatitans.org/schools/cottage-school', title: 'TCA Cottage School' },
  { url: 'https://www.tcatitans.org/enroll', title: 'TCA Enrollment' },
  { url: 'https://www.tcatitans.org/family/school-hoursbell-schedule', title: 'TCA Bell Schedule & School Hours' },
  { url: 'https://www.tcatitans.org/family/dress-code', title: 'TCA Dress Code' },
  { url: 'https://www.tcatitans.org/family/attendance-absences', title: 'TCA Attendance & Absences' },
  { url: 'https://www.tcatitans.org/family/lunch-information', title: 'TCA Lunch Information' },
]

function isAuthorized(req: NextRequest): boolean {
  if (req.headers.get('x-vercel-cron') === '1') return true
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret === process.env.CRAWL_SECRET) return true
  return req.headers.get('authorization') === `Bearer ${process.env.CRAWL_SECRET}`
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|td|th)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ').replace(/&[a-z]+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim()
}

function chunkText(text: string, size = 1800, overlap = 200): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    chunks.push(text.slice(start, start + size))
    start += size - overlap
  }
  return chunks
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { VoyageAIClient } = await import('voyageai')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()
  let indexed = 0, skipped = 0, errors = 0

  for (const page of SEED_PAGES) {
    try {
      const res = await fetch(page.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TCAHub/1.0)' },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) { skipped++; continue }

      const html = await res.text()
      const text = htmlToText(html)
      if (text.length < 150) { skipped++; continue }

      await supabase.from('page_chunks').delete().eq('url', page.url)

      const chunks = chunkText(text)
      const embRes = await voyage.embed({
        input: chunks.map(c => c.slice(0, 16000)),
        model: 'voyage-3-lite',
      })

      for (let i = 0; i < chunks.length; i++) {
        const embedding = embRes.data?.[i]?.embedding
        if (!embedding) continue
        const { error } = await supabase.from('page_chunks').insert({
          url: page.url,
          title: page.title,
          content: chunks[i],
          embedding,
          crawled_at: now,
        })
        if (error) errors++; else indexed++
      }
    } catch {
      errors++
    }
  }

  return NextResponse.json({ pages: SEED_PAGES.length, indexed, skipped, errors })
}

export async function POST(req: NextRequest) {
  return GET(req)
}
