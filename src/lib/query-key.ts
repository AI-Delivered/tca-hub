// Canonical key for grouping questions that mean the same thing.
//
// Parents retype rather than paste, and TCA has three names for everything:
// "Who's the middle school principal", "Whos the MS principal", and "who is the
// junior high principal" are one question, and the dashboard should treat them
// that way — both for counting repeats and for deciding whether a past failure
// has since been fixed.
//
// Deliberately lossy. Over-merging two similar questions costs a dashboard row;
// under-merging leaves a fixed question sitting in the needs-attention list.

// Multi-word forms first, so "junior high" is consumed before the bare "junior"
// (an 11th grader) can be mistaken for it.
const PHRASE_SYNONYMS: Array<[RegExp, string]> = [
  [/\b(junior high school|junior high|middle school|jr high)\b/g, 'juniorhigh'],
  [/\b(college pathways|college pathway)\b/g, 'collegepathways'],
  [/\b(cottage school program|cottage school|csp)\b/g, 'cottageschool'],
  [/\b(high school)\b/g, 'highschool'],
  [/\b(east elementary|east campus)\b/g, 'east'],
  [/\b(central elementary|central campus)\b/g, 'central'],
  [/\b(north elementary|north campus)\b/g, 'north'],
  [/\b(7th|8th|seventh|eighth) grader?s?\b/g, 'juniorhigh'],
  [/\b(9th|10th|11th|12th|ninth|tenth|eleventh|twelfth) grader?s?\b/g, 'highschool'],
  [/\b(freshman|freshmen|sophomore|sophomores|senior|seniors)\b/g, 'highschool'],
  [/\b(no school|day off|days off)\b/g, 'dayoff'],
  [/\b(drop off|dropoff|pick up|pickup|car line|carpool)\b/g, 'carpool'],
  [/\b(e mail|email address|emails)\b/g, 'email'],
]

const TOKEN_SYNONYMS: Record<string, string> = {
  jh: 'juniorhigh', ms: 'juniorhigh', hs: 'highschool', cp: 'collegepathways',
  whos: 'who', whose: 'who', wheres: 'where', whens: 'when', hows: 'how',
  kindergarten: 'kinder', kinder: 'kinder', prek: 'kinder',
  counsellor: 'counselor', phone: 'contact', number: 'contact', email: 'contact',
  kids: 'kid', child: 'kid', children: 'kid', student: 'kid', students: 'kid',
}

// "Mrs. Smith" and "Miss Smith" are the same person; the honorific carries nothing.
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'sr', 'fr', 'coach'])

// …unless the word after it is a role or topic, in which case "ms" was never an
// honorific — it was the middle school ("who is the MS principal").
const TOPIC_AFTER_HONORIFIC = /principal|teacher|counsel|nurse|dean|office|staff|secretar|registrar|librarian|calendar|schedule|lunch|sport|game|practice|start|end|day|drop|pick|bell|hour/

const FILLER = new Set([
  'the', 'a', 'an', 'at', 'in', 'on', 'of', 'for', 'to', 'is', 'are', 'was', 'were',
  'be', 'do', 'does', 'did', 'my', 'our', 'me', 'i', 'we', 'you', 'your', 'it', 'its',
  'that', 'this', 'there', 'and', 'or', 'with', 'about', 'please', 'tell', 'know',
  'need', 'want', 'can', 'could', 'would', 'get', 'find', 'looking', 'anyone',
  'someone', 'tca', 'titans', 'school', 'schools', 'campus', 'info', 'information',
  'have', 'has', 'go', 'going', 'up', 'out', 'any', 'some', 'next', 'new',
])

function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return token.slice(0, -3) + 'y'
  if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2)
  if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1)
  return token
}

export function queryKey(raw: string): string {
  // Apostrophes close up ("who's" → "whos") so the token map can catch them;
  // every other mark becomes a space.
  let s = raw.toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9\s]/g, ' ')
  for (const [re, replacement] of PHRASE_SYNONYMS) s = s.replace(re, replacement)

  const raws = s.split(/\s+/).filter(Boolean)
  const tokens: string[] = []
  for (let i = 0; i < raws.length; i++) {
    const t = raws[i]
    if (HONORIFICS.has(t)) {
      const next = raws[i + 1] ?? ''
      // "ms principal" is the middle school; "ms smith" is a person
      if (!TOPIC_AFTER_HONORIFIC.test(next)) continue
      if (t === 'ms') { tokens.push('juniorhigh'); continue }
      continue
    }
    const mapped = TOKEN_SYNONYMS[t] ?? t
    if (FILLER.has(mapped)) continue
    tokens.push(stem(mapped))
  }

  // Order-insensitive: "Mrs Smith email" and "email for Mrs Smith" are one question.
  return [...new Set(tokens)].sort().join(' ')
}
