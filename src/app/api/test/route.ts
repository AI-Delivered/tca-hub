import { NextRequest, NextResponse } from 'next/server'
import { isCrawlAuthorized } from '@/lib/auth'

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
    answer.trim().length < 20
  )
}

/* Reading /api/search, which streams.
 *
 * This route called `res.json()` on it. /api/search has answered in NDJSON — one
 * JSON object per line, `{"type":"text",…}` — since it began streaming, and
 * `res.json()` cannot parse that: it throws, the catch records `Error: …`, and the
 * question is reported as failed. So every question failed, on every run,
 * regardless of what the app actually said. A harness that always reports failure
 * is exactly as useful as one that always reports success, and this one has been
 * doing it quietly. scripts/check-answers.mjs reads the same stream correctly,
 * which is why the two disagreed.
 */
async function ask(baseUrl: string, query: string): Promise<{ answer: string; sources: number }> {
  const res = await fetch(`${baseUrl}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Bypasses the answer cache: a verification run has to see what retrieval and
    // generation do now, not read back what they did an hour ago.
    body: JSON.stringify({ query, debug: true }),
  })
  if (res.status === 429) throw new Error('rate limited by /api/search')
  if (!res.ok) throw new Error(`/api/search returned ${res.status}`)

  let answer = ''
  let sources = 0
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event.type === 'text') answer += event.text
      if (event.type === 'sources') sources = event.sources?.length ?? 0
    } catch { /* a partial line at the end of the stream */ }
  }
  return { answer: answer.trim(), sources }
}

export async function GET(req: NextRequest) {
  if (!isCrawlAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const baseUrl = req.nextUrl.origin

  /* One question, asked from outside, in a URL.
   *
   * Confirming a fix meant crafting a POST with a JSON body, which rules out a
   * browser, a phone, and anything holding only the crawl secret. `?q=` is the same
   * ask in a form a person can paste — and it returns the whole answer rather than
   * the first 200 characters, because the point is to read what a parent would
   * read. Behind the same gate as the rest of this route: it spends a generation.
   */
  const single = req.nextUrl.searchParams.get('q')?.trim()
  if (single) {
    const start = Date.now()
    try {
      const { answer, sources } = await ask(baseUrl, single)
      return NextResponse.json({
        question: single,
        answered: !isBlank(answer),
        answer,
        sources,
        ms: Date.now() - start,
      })
    } catch (e) {
      return NextResponse.json({
        question: single,
        answered: false,
        error: String(e instanceof Error ? e.message : e),
        ms: Date.now() - start,
      }, { status: 502 })
    }
  }

  const results = []
  for (const test of TEST_QUESTIONS) {
    const start = Date.now()
    try {
      const { answer, sources } = await ask(baseUrl, test.q)
      results.push({
        question: test.q,
        category: test.category,
        pass: !isBlank(answer),
        answer: answer.slice(0, 200),
        sources,
        ms: Date.now() - start,
      })
    } catch (e) {
      results.push({
        question: test.q,
        category: test.category,
        pass: false,
        answer: `Error: ${e instanceof Error ? e.message : e}`,
        sources: 0,
        ms: Date.now() - start,
      })
    }
  }

  const passed = results.filter(r => r.pass).length
  // `errors` so a broken run shows up in the same dashboard column as everything
  // else that fails, rather than as a healthy row with a low pass count.
  return NextResponse.json({ passed, total: results.length, errors: results.length - passed, results })
}
