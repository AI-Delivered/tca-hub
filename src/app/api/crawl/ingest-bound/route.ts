import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase'

export const maxDuration = 60

const BOUND_HOME = 'https://www.gobound.com/co/schools/theclassahs'

// TCA sports programs — static list (gobound requires JS rendering to scrape dynamically)
// Schedule data comes from iCal feeds via ingest-ical
const TCA_SPORTS = [
  'Football (Varsity, JV, JH A, JH B, C-Squad)',
  'Boys Basketball (Varsity, JV, JH A, JH B)',
  'Girls Basketball (Varsity, JV, JH A, JH B)',
  'Boys Soccer (Varsity, JV)',
  'Girls Soccer (Varsity, JV)',
  'Cross Country (Boys & Girls)',
  'Wrestling',
  'Volleyball (Varsity, JV, JH A, JH B)',
  'Baseball',
  'Softball',
  'Track & Field (Boys & Girls)',
  'Golf',
  'Cheer',
  'Dance',
  'Swimming',
  'Tennis',
]

function isAuthorized(req: NextRequest): boolean {
  if (req.headers.get('x-vercel-cron') === '1') return true
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret === process.env.CRAWL_SECRET) return true
  return req.headers.get('authorization') === `Bearer ${process.env.CRAWL_SECRET}`
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { VoyageAIClient } = await import('voyageai')
  const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()

  const content = `TCA Classical Academy (The Classical Academy) Athletics & Activities:\n\nSports offered:\n${TCA_SPORTS.map(s => '- ' + s).join('\n')}\n\nFor schedules, rosters, standings, and game results visit: ${BOUND_HOME}\nFor iCal schedule feeds and up-to-date game times, see the TCA Athletics iCal feed.`

  await supabase.from('page_chunks').delete().eq('url', BOUND_HOME)

  const embRes = await voyage.embed({ input: [content], model: 'voyage-3-lite' })
  const { error } = await supabase.from('page_chunks').insert({
    url: BOUND_HOME,
    title: 'TCA Athletics & Activities',
    content,
    embedding: embRes.data![0].embedding!,
    crawled_at: now,
  })

  return NextResponse.json({ ok: !error, error: error?.message })
}
