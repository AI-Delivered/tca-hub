import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export const maxDuration = 300

const CAMPUSES = [
  { name: 'East Elementary', url: 'https://www.tcatitans.org/schools/east-elementary/east-elementary-staff-directory' },
  { name: 'Central Elementary', url: 'https://www.tcatitans.org/schools/central-elementary/central-elementary-staff-directory' },
  { name: 'North Elementary', url: 'https://www.tcatitans.org/schools/north-elementary/north-elementary-staff-directory' },
  { name: 'Junior High', url: 'https://www.tcatitans.org/schools/junior-high/junior-high-staff-directory' },
  { name: 'High School', url: 'https://www.tcatitans.org/schools/high-school/high-school-staff-directory' },
  { name: 'College Pathways', url: 'https://www.tcatitans.org/schools/college-pathways/college-pathways-staff-directory' },
  { name: 'Cottage School', url: 'https://www.tcatitans.org/schools/cottage-school/csp-staff-directory' },
]

function isAuthorized(req: NextRequest): boolean {
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret === process.env.CRAWL_SECRET) return true
  return req.headers.get('authorization') === `Bearer ${process.env.CRAWL_SECRET}`
}

interface StaffMember { name: string; role: string }

// Works for both campus-specific (name, role, photo) and global (name, role, campus, photo)
function extractStaff(md: string): StaffMember[] {
  const members: StaffMember[] = []
  for (const m of md.matchAll(/###\s+\[([^\]]+)\]\([^)]+\)\n\n([^\n![\]]+)/g)) {
    const name = m[1].trim()
    const role = m[2].trim()
    if (name && role && !role.startsWith('http') && role.length < 80) {
      members.push({ name, role })
    }
  }
  return members
}

function getTotalPages(md: string): number {
  const m = md.match(/showing\s+\d+\s*-\s*\d+\s+of\s+(\d+)\s+constituents/i)
  if (!m) return 1
  return Math.ceil(parseInt(m[1]) / 12)
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Allow targeting a single campus to avoid timeouts
  const campusFilter = req.nextUrl.searchParams.get('campus')
  const targets = campusFilter
    ? CAMPUSES.filter(c => c.name.toLowerCase().includes(campusFilter.toLowerCase()))
    : CAMPUSES

  const { VoyageAIClient } = await import('voyageai')
  const { default: FirecrawlApp } = await import('@mendable/firecrawl-js')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY }) as any
  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()
  const results = []

  for (const campus of targets) {
    const allStaff: StaffMember[] = []
    const seen = new Set<string>()

    const addStaff = (members: StaffMember[]) => {
      for (const m of members) {
        if (!seen.has(m.name)) { seen.add(m.name); allStaff.push(m) }
      }
    }

    // Page 1: normal scrape
    const first = await firecrawl.scrapeUrl(campus.url, { formats: ['markdown'], waitFor: 3000 })
    const firstMd: string = first?.markdown ?? ''
    const totalPages = getTotalPages(firstMd)
    addStaff(extractStaff(firstMd))

    // Pages 2+: click the pagination link from the base URL
    for (let page = 2; page <= totalPages; page++) {
      try {
        const r = await firecrawl.scrapeUrl(campus.url, {
          formats: ['markdown'],
          actions: [
            { type: 'wait', milliseconds: 2000 },
            { type: 'click', selector: `a[href*="const_page=${page}"]` },
            { type: 'wait', milliseconds: 2000 },
          ],
          waitFor: 5000,
        })
        addStaff(extractStaff(r?.markdown ?? ''))
      } catch {
        // skip failed pages
      }
    }

    // Group by role
    const byRole: Record<string, string[]> = {}
    for (const s of allStaff) {
      if (!byRole[s.role]) byRole[s.role] = []
      byRole[s.role].push(s.name)
    }

    const lines = [`${campus.name} Staff Directory (${allStaff.length} staff members):`]
    for (const [role, names] of Object.entries(byRole).sort()) {
      lines.push(`  ${role}: ${names.join(', ')}`)
    }
    const content = lines.join('\n')

    // Replace existing chunk for this campus
    await supabase.from('page_chunks').delete().eq('url', campus.url)
    const embRes = await voyage.embed({ input: [content.slice(0, 16000)], model: 'voyage-3-lite' })
    const { error } = await supabase.from('page_chunks').insert({
      url: campus.url,
      title: `${campus.name} Staff Directory`,
      content,
      embedding: embRes.data![0].embedding!,
      crawled_at: now,
    })

    results.push({ campus: campus.name, staff: allStaff.length, pages: totalPages, error: error?.message })
  }

  return NextResponse.json({ results })
}
