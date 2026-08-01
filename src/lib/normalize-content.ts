// Corrections applied to scraped text before it is stored.
//
// The school's own pages are not always current, and a page nobody has edited
// since a change went through will keep serving the old answer indefinitely.
// This is where a known, verified correction gets applied once rather than
// being re-litigated per route.

/* TCA moved staff email from @asd20.org to @tcatitans.org over summer 2026.
 *
 * From the East Elementary newsletter of August 2026: "This summer TCA went
 * through a network domain change, so staff email addresses have changed from
 * @asd20.org to @tcatitans.org."
 *
 * The site had not caught up. 83 distinct @asd20.org addresses were sitting in
 * 105 chunks, and the app was handing them out — "who is the football coach"
 * answered jrich@asd20.org, which no longer receives mail. A parent emailing a
 * coach from that answer would have got silence and no bounce worth noticing.
 *
 * The local part is preserved, which is not an assumption: 48 of the 83 already
 * appeared in the corpus under both domains with identical local parts, from
 * pages the school had updated. So this rewrites the domain and nothing else.
 *
 * Deliberately narrow. Academy District 20 is a real organisation and
 * @asd20.org is a real domain; this only claims that TCA *staff* moved, which
 * is what the newsletter says and what the corpus corroborates.
 */
/* The optional space is not hypothetical: the East Elementary PE page lists
 * "Kristen Ford kford @asd20.org", and a pattern without it left that one
 * address wrong while correcting the other 183. The tail is where these hide.
 *
 * msa.asd20.org is deliberately excluded — student accounts live on that
 * subdomain and did not move. So is a bare "asd20.org", which is District 20's
 * own website and still correct wherever the site links to it. */
const RETIRED_STAFF_DOMAIN = /\b([\w.+-]+)\s?@asd20\.org\b/gi

export function normalizeContent(text: string): string {
  return text.replace(RETIRED_STAFF_DOMAIN, (_m, local) => `${local}@tcatitans.org`)
}

/** How many addresses a piece of text would have corrected. For reporting. */
export function countRetiredAddresses(text: string): number {
  return (text.match(RETIRED_STAFF_DOMAIN) ?? []).length
}
