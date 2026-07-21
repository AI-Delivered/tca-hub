import { NextRequest, NextResponse } from 'next/server'

export const maxDuration = 300

const TEST_QUESTIONS = [
  // Calendar / dates
  { q: 'When is the first day of school?', category: 'Calendar' },
  { q: 'When is fall break?', category: 'Calendar' },
  { q: 'When is Thanksgiving break?', category: 'Calendar' },
  { q: 'When does winter break start?', category: 'Calendar' },
  // Schedule
  { q: 'What time does school start?', category: 'Schedule' },
  { q: 'What time does school end?', category: 'Schedule' },
  { q: 'What is the bell schedule for high school?', category: 'Schedule' },
  // Policies
  { q: 'What is the dress code?', category: 'Policy' },
  { q: 'How do I report an absence?', category: 'Policy' },
  { q: 'What are the school supply lists?', category: 'Policy' },
  { q: 'What is the lunch schedule?', category: 'Policy' },
  // Contact / staff
  { q: 'How do I contact the front office?', category: 'Contact' },
  { q: 'Where is the staff directory?', category: 'Contact' },
  // Enrollment
  { q: 'How do I enroll at TCA?', category: 'Enrollment' },
  { q: 'What grades does TCA offer?', category: 'Enrollment' },
]

function isBlank(answer: string): boolean {
  const lower = answer.toLowerCase()
  return (
    lower.includes("couldn't find") ||
    lower.includes("don't have") ||
    lower.includes("not available") ||
    lower.includes("no information") ||
    lower.includes("not in the context") ||
    answer.trim().length < 40
  )
}

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRAWL_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const baseUrl = req.nextUrl.origin
  const results = []

  for (const test of TEST_QUESTIONS) {
    const start = Date.now()
    try {
      const res = await fetch(`${baseUrl}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: test.q }),
      })
      const data = await res.json()
      const ms = Date.now() - start
      const answer = data.answer ?? ''
      results.push({
        question: test.q,
        category: test.category,
        pass: !isBlank(answer),
        answer: answer.slice(0, 200),
        sources: data.sources?.length ?? 0,
        ms,
      })
    } catch (e) {
      results.push({
        question: test.q,
        category: test.category,
        pass: false,
        answer: `Error: ${e}`,
        sources: 0,
        ms: Date.now() - start,
      })
    }
  }

  const passed = results.filter(r => r.pass).length
  return NextResponse.json({ passed, total: results.length, results })
}
