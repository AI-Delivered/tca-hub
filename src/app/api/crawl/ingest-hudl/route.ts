import { NextRequest, NextResponse } from 'next/server'

// Hudl requires JavaScript rendering — use iCal feeds instead.
// JH Football: /api/crawl/ingest-ical (team 161822)
// HS Football: /api/crawl/ingest-ical (team 20623)
// All athletics: /api/crawl/ingest-ical (gobound iCal feed)

export async function GET(_req: NextRequest) {
  return NextResponse.json({
    message: 'Hudl ingestion is no longer used. Athletics schedules are pulled from gobound iCal and TeamReach iCal feeds via /api/crawl/ingest-ical.',
  })
}
