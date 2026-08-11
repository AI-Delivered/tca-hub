/* Is this page actually about *this* school?
 *
 * ingest-email takes a Smore URL from whoever calls it, fetches it, and stores the
 * text stamped with a provenance line that says "the TCA campus newsletter" — an
 * assertion nothing checked. Paste the wrong URL and another school's dates enter
 * the corpus wearing this school's name, which is the one kind of wrong answer no
 * amount of retrieval work downstream can catch.
 *
 * That is not a hypothetical mis-paste. Searching for TCA's newsletter turns up
 * several publications called "Titan eNews", and at least one of them belongs to
 * Academy High School — the same school district as TCA (Academy District 20), the
 * same city, the same Titan branding, the same newsletter platform. A human
 * skimming search results would take it for TCA's, and the URL that hosts it,
 * `secure.smore.com/r92zm`, has no slug in it to say otherwise.
 *
 * Which is why the district domain cannot be the test. Every ASD20 school has an
 * @asd20.org address, so "asd20.org" reads as confirmation while proving only that
 * two schools are neighbours. The markers below are the ones that belong to TCA
 * and to nothing else: its own name, its own web domain, its own mailboxes. A
 * newsletter that names none of them has not identified itself.
 */

/** Markers that belong to The Classical Academy and to no other ASD20 school. */
const TCA_MARKERS: Array<{ what: string; re: RegExp }> = [
  { what: 'the school\'s name', re: /\bclassical academy\b/i },
  { what: 'the school\'s web domain', re: /\btcatitans\.org\b/i },
  // tcacentralelementary@asd20.org and its siblings: the district domain, but a
  // mailbox only this school has. Bare "@asd20.org" is deliberately not enough.
  { what: 'a TCA mailbox on the district domain', re: /\btca[a-z0-9._-]*@asd20\.org\b/i },
]

/* TCA is an ASD20 charter, so its own newsletters carry district addresses — and
 * the first version of this refused any page that named nothing but those.
 *
 * That is a false refusal waiting to happen. A campus newsletter headed "TCA
 * Junior High" with a frontoffice@asd20.org contact and no expansion of the
 * initials anywhere is unmistakably this school's to a reader, and would have been
 * turned away. So the initials count after all — but only where they are attached
 * to one of this school's own campuses or programs.
 *
 * Attached, not merely both present somewhere on the page. "TCA" anywhere plus
 * "high school" anywhere is satisfied by a rival's athletics newsletter reporting
 * a game against TCA, which is the exact class of page this guard exists to keep
 * out. "TCA Junior High" and "TCA Central" are names; two words in the same
 * newsletter are a coincidence.
 */
const TCA_CAMPUS_PHRASE =
  /\bTCA['’]?s?\s+(?:central|east|north|junior\s+high|jh\b|high\s+school|hs\b|college\s+pathways|cottage\s+school)/i

/* Names TCA shares with its neighbours, which is precisely why they do not count.
 *
 * Kept as a list rather than dropped, so a refusal can say what it *did* find —
 * "this page says Titan and asd20.org but never names the school" is an actionable
 * message, and "not TCA" is not. */
const AMBIGUOUS_MARKERS: Array<{ what: string; re: RegExp }> = [
  { what: 'Titan branding, which several ASD20 schools use', re: /\btitans?\b/i },
  { what: 'the district domain, shared by every ASD20 school', re: /@asd20\.org\b/i },
  { what: 'Colorado Springs', re: /\bcolorado springs\b/i },
  { what: 'the initials TCA, which the page never expands', re: /\bTCA\b/ },
]

export interface SchoolIdentity {
  /** True when the text names this school in a way no neighbouring school would. */
  identified: boolean
  /** Which marker settled it. */
  matched: string[]
  /** What was found that looks like confirmation but is not. */
  ambiguous: string[]
}

/** Whether some fetched text identifies itself as belonging to TCA. */
export function identifiesSchool(text: string): SchoolIdentity {
  const matched = TCA_MARKERS.filter(m => m.re.test(text)).map(m => m.what)
  if (TCA_CAMPUS_PHRASE.test(text)) {
    matched.push('the initials TCA attached to one of its own campuses or programs')
  }
  return {
    identified: matched.length > 0,
    matched,
    ambiguous: matched.length ? [] : AMBIGUOUS_MARKERS.filter(m => m.re.test(text)).map(m => m.what),
  }
}

/** The refusal to hand back when a page has not identified itself, or '' when it has. */
export function identityRefusal(text: string, url: string): string {
  const identity = identifiesSchool(text)
  if (identity.identified) return ''
  const found = identity.ambiguous.length
    ? `What it does carry is ${identity.ambiguous.join('; ')} — none of which distinguishes TCA from ` +
      `another Academy District 20 school. There is more than one "Titan eNews" on Smore and at least one ` +
      `belongs to a different ASD20 school.`
    : 'Nothing in it names a school at all, which usually means the page did not render.'
  return `${url} never names The Classical Academy. ${found} ` +
    `Check the URL is the right school's newsletter; if you have confirmed it by hand, re-send with ` +
    `allowUnverifiedSchool=true.`
}
