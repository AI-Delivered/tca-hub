import { NextRequest, NextResponse } from 'next/server'

function isAuthorized(req: NextRequest): boolean {
  if (req.headers.get('x-vercel-cron') === '1') return true
  return req.headers.get('authorization') === `Bearer ${process.env.CRAWL_SECRET}`
}

// Starts the Firecrawl job and returns the jobId immediately.
// Call /api/crawl/ingest?jobId=xxx after ~5 minutes to index the results.
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { default: FirecrawlApp } = await import('@mendable/firecrawl-js')
  const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY })
  const targetUrl = process.env.CRAWL_TARGET_URL ?? 'https://www.tcatitans.org'

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const job = await (firecrawl.asyncCrawlUrl as any)(targetUrl, {
    limit: 300,
    scrapeOptions: { formats: ['markdown'] },
  })

  if (!job?.id) {
    return NextResponse.json({ error: 'Failed to start crawl job', detail: job }, { status: 500 })
  }

  return NextResponse.json({
    jobId: job.id,
    next: `Call POST /api/crawl/ingest with { "jobId": "${job.id}" } after ~5 minutes`,
  })
}

// Nightly cron: start a fresh crawl job (ingest handled separately)
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return POST(req)
}
