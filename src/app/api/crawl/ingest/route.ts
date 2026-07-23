import { NextRequest, NextResponse } from 'next/server'

// This route processed Firecrawl async job results and is no longer needed.
// The main crawl at /api/crawl now does everything in one pass using fetch().

export async function POST(_req: NextRequest) {
  return NextResponse.json({
    message: 'Firecrawl job processing is no longer used. Run GET /api/crawl to crawl and index directly.',
  })
}
