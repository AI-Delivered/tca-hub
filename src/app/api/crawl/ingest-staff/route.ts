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

// TCA email pattern: {first_initial}{last}@tcatitans.org
// Verified from financial transparency page: mvangampleare@tcatitans.org, myeadon@tcatitans.org
// Note: some staff have disambiguation suffixes (jpeterson1) that can't be inferred
function inferEmail(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length < 2) return ''
  const first = parts[0].replace(/[^a-zA-Z]/g, '').toLowerCase()
  const last = parts[parts.length - 1].replace(/[^a-zA-Z]/g, '').toLowerCase()
  if (!first || !last) return ''
  return `${first[0]}${last}@tcatitans.org`
}

// Role groups for chunking — leadership gets its own chunk, everything else batched by category
const LEADERSHIP_ROLES = [
  'principal', 'assistant principal', 'dean', 'counselor', 'director',
  'vice principal', 'head of school', 'superintendent',
]

const SUPPORT_ROLES = [
  'secretary', 'office manager', 'registrar', 'nurse', 'social worker',
  'librarian', 'assistant librarian', 'technology', 'it ', 'tech support',
  'custodian', 'food', 'bookkeeper', 'accountant', 'receptionist',
  'office', 'administrative',
]

const SPECIALIST_ROLES = [
  'art teacher', 'music teacher', 'band teacher', 'choir teacher',
  'orchestra teacher', 'pe teacher', 'physical education', 'drama teacher',
  'theater', 'dance teacher', 'stem teacher', 'computer teacher',
  'media specialist', 'reading specialist', 'speech', 'occupational',
  'accompanist', 'athletic', 'activities',
]

function categorize(role: string): string {
  const r = role.toLowerCase()
  if (LEADERSHIP_ROLES.some(l => r.includes(l))) return 'Leadership'
  if (SUPPORT_ROLES.some(l => r.includes(l))) return 'Office & Support Staff'
  if (SPECIALIST_ROLES.some(l => r.includes(l))) return 'Specialist Teachers'
  // Grade-level grouping for elementary
  const gradeMatch = r.match(/^(\d+)(?:st|nd|rd|th)\s+grade/)
  if (gradeMatch) {
    const g = parseInt(gradeMatch[1])
    if (g <= 2) return 'K–2 Teachers & Paras'
    if (g <= 4) return 'Grade 3–4 Teachers & Paras'
    return 'Grade 5–6 Teachers & Paras'
  }
  if (r.includes('kindergarten') || r.includes('kinder')) return 'K–2 Teachers & Paras'
  if (r.includes('paraprofessional') || r.includes('para ') || r.includes('aide')) return 'K–2 Teachers & Paras'
  // Secondary subject grouping
  if (/english|writing|reading|literature|lang|humanities|history|social studies|civics|economics|geography/.test(r)) return 'English & Humanities Teachers'
  if (/math|algebra|calculus|geometry|statistics|physics|chemistry|biology|science|earth/.test(r)) return 'Math & Science Teachers'
  if (/pe |physical ed|health|weight|fitness|strength/.test(r)) return 'Specialist Teachers'
  if (/world language|spanish|french|latin|chinese|german/.test(r)) return 'World Language Teachers'
  if (/classical|philosophy|logic|rhetoric|grammar|rhetoric|great books|seminar/.test(r)) return 'Classical Studies Teachers'
  return 'Teaching Staff'
}

function isAuthorized(req: NextRequest): boolean {
  if (req.headers.get('x-vercel-cron') === '1') return true
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret === process.env.CRAWL_SECRET) return true
  return req.headers.get('authorization') === `Bearer ${process.env.CRAWL_SECRET}`
}

interface StaffMember { name: string; role: string; photo: string }

function extractFromHtml(html: string): { staff: StaffMember[]; groupIds: string; totalPages: number } {
  const names = [...html.matchAll(/class="fsFullName">\s*<a[^>]+>([^<]+)<\/a>/g)].map(m => m[1].trim())
  const roles = [...html.matchAll(/class="fsTitles">\s*([^\n<]+)/g)].map(m => m[1].trim())
  const photos = [...html.matchAll(/class="fsPhoto">\s*<img[^>]+src="([^"]+)"/g)].map(m => {
    const src = m[1]
    if (src.toLowerCase().includes('placeholder')) return ''
    return src.startsWith('/') ? `https://www.tcatitans.org${src}` : src
  })
  const staff = names.map((name, i) => ({ name, role: roles[i] ?? '', photo: photos[i] ?? '' })).filter(s => s.name && s.role)

  const groupMatch = html.match(/name="const_search_group_ids" value="([^"]+)"/)
  const groupIds = groupMatch ? groupMatch[1] : ''

  const allDataPages = [...html.matchAll(/data-page="(\d+)"/g)].map(m => parseInt(m[1]))
  const totalMatch = html.match(/of (\d+) constituents/)
  const totalPages = allDataPages.length
    ? Math.max(...allDataPages)
    : totalMatch ? Math.ceil(parseInt(totalMatch[1]) / 12) : 1

  return { staff, groupIds, totalPages }
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const campusFilter = req.nextUrl.searchParams.get('campus')
  const targets = campusFilter
    ? CAMPUSES.filter(c => c.name.toLowerCase().includes(campusFilter.toLowerCase()))
    : CAMPUSES

  const { VoyageAIClient } = await import('voyageai')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()
  const results = []

  for (const campus of targets) {
    const seen = new Map<string, { role: string; photo: string }>() // name → { role, photo }

    // Page 1 — also extracts groupIds and total pages
    const page1Html = await fetch(campus.url).then(r => r.text()).catch(() => '')
    const { staff: page1Staff, groupIds, totalPages } = extractFromHtml(page1Html)
    for (const { name, role, photo } of page1Staff) {
      if (!seen.has(name)) seen.set(name, { role, photo })
    }

    // Remaining pages
    for (let page = 2; page <= totalPages; page++) {
      const params = new URLSearchParams({ const_search_role_ids: '1', const_page: String(page) })
      if (groupIds) params.set('const_search_group_ids', groupIds)
      const html = await fetch(`${campus.url}?${params}`).then(r => r.text()).catch(() => '')
      for (const { name, role, photo } of extractFromHtml(html).staff) {
        if (!seen.has(name)) seen.set(name, { role, photo })
      }
      await new Promise(r => setTimeout(r, 300))
    }

    // Group staff by category
    const byCategory: Record<string, Array<{ name: string; role: string; email: string; photo: string }>> = {}
    for (const [name, { role, photo }] of seen.entries()) {
      const cat = categorize(role)
      if (!byCategory[cat]) byCategory[cat] = []
      byCategory[cat].push({ name, role, email: inferEmail(name), photo })
    }

    // Delete old chunks for this campus
    await supabase.from('page_chunks').delete().ilike('url', `${campus.url}%`)

    let chunksInserted = 0

    // One chunk per category — small, targeted, easy to retrieve
    for (const [category, members] of Object.entries(byCategory)) {
      // Sort: leadership roles first within each category
      members.sort((a, b) => {
        const aIsLeader = LEADERSHIP_ROLES.some(l => a.role.toLowerCase().includes(l))
        const bIsLeader = LEADERSHIP_ROLES.some(l => b.role.toLowerCase().includes(l))
        if (aIsLeader && !bIsLeader) return -1
        if (!aIsLeader && bIsLeader) return 1
        return a.role.localeCompare(b.role)
      })

      const lines = [
        `${campus.name} — ${category}:`,
        `(Contact info: ${campus.url})`,
        '',
      ]

      // Group by exact role within the category
      const byRole: Record<string, Array<{ name: string; email: string; photo: string }>> = {}
      for (const m of members) {
        if (!byRole[m.role]) byRole[m.role] = []
        byRole[m.role].push({ name: m.name, email: m.email, photo: m.photo })
      }

      for (const [role, people] of Object.entries(byRole)) {
        for (const p of people) {
          const photoTag = p.photo ? ` [photo:${p.photo}]` : ''
          lines.push(`${role}: ${p.name} — ${p.email}${photoTag}`)
        }
      }

      const content = lines.join('\n')
      const title = `${campus.name} — ${category}`
      const chunkUrl = `${campus.url}#${category.toLowerCase().replace(/[^a-z0-9]/g, '-')}`

      const embRes = await voyage.embed({ input: [content.slice(0, 16000)], model: 'voyage-3-lite' })
      const embedding = embRes.data?.[0]?.embedding
      if (!embedding) continue

      const { error } = await supabase.from('page_chunks').insert({
        url: chunkUrl, title, content, embedding, crawled_at: now,
      })
      if (!error) chunksInserted++
    }

    // Also keep a summary chunk for "who works at X" queries
    const summaryLines = [
      `${campus.name} Staff Directory — Full List (${seen.size} staff):`,
      `For individual contact info: ${campus.url}`,
      '',
    ]
    const byRole: Record<string, string[]> = {}
    for (const [name, { role, photo }] of seen.entries()) {
      if (!byRole[role]) byRole[role] = []
      const photoTag = photo ? ` [photo:${photo}]` : ''
      byRole[role].push(`${name} (${inferEmail(name)})${photoTag}`)
    }
    // Put leadership roles first
    const leadershipFirst = Object.entries(byRole).sort(([a], [b]) => {
      const aL = LEADERSHIP_ROLES.some(l => a.toLowerCase().includes(l))
      const bL = LEADERSHIP_ROLES.some(l => b.toLowerCase().includes(l))
      if (aL && !bL) return -1
      if (!aL && bL) return 1
      return a.localeCompare(b)
    })
    for (const [role, names] of leadershipFirst) {
      summaryLines.push(`${role}: ${names.join(', ')}`)
    }

    const summaryContent = summaryLines.join('\n')
    const summaryEmb = await voyage.embed({ input: [summaryContent.slice(0, 16000)], model: 'voyage-3-lite' })
    const summaryEmbedding = summaryEmb.data?.[0]?.embedding
    if (summaryEmbedding) {
      await supabase.from('page_chunks').insert({
        url: campus.url,
        title: `${campus.name} Staff Directory`,
        content: summaryContent,
        embedding: summaryEmbedding,
        crawled_at: now,
      })
      chunksInserted++
    }

    results.push({ campus: campus.name, staff: seen.size, pages: totalPages, chunksInserted })
  }

  return NextResponse.json({ results })
}
