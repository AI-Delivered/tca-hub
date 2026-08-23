// Proof that a Smore URL without a slug can be read, and cannot delete the corpus.
//
// Run with: node scripts/test-smore.mjs
//
// The address a parent actually forwards is https://app.smore.com/n/fnkg61 — no
// slug. That was rejected outright, so the one URL shape people have was the one
// shape this could not read. Relaxing the pattern is four characters; doing it
// safely is the rest of this file, because the slug is what supersession deletes
// on and an empty one reaches ilike as `%-%`, which matches nearly every url in
// the corpus.

import {
  parseSmoreUrl, isPublicationSlug, supersedePattern, publicationSlugFromTitle, linkedDocuments,
} from '../src/lib/smore.ts'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`}`)
}
const checkTrue = (name, actual) => check(name, actual, true)

console.log('\n— the URL people actually have —\n')

const bare = parseSmoreUrl('https://app.smore.com/n/fnkg61')
check('a slug-less issue parses', bare?.issueId, 'fnkg61')
check('and says it has no publication', bare?.publicationSlug, null)
check('the canonical url keeps just the id', bare?.url, 'https://app.smore.com/n/fnkg61')

const full = parseSmoreUrl('https://secure.smore.com/n/ehg53-tca-east-elementary-news')
check('a slugged issue still parses', full?.publicationSlug, 'tca-east-elementary-news')
check('and normalises to app.smore.com', full?.url, 'https://app.smore.com/n/ehg53-tca-east-elementary-news')
check('query strings and fragments are dropped',
  parseSmoreUrl('https://www.smore.com/n/fnkg61?utm_source=email#top')?.url, 'https://app.smore.com/n/fnkg61')
check('a trailing slash is fine', parseSmoreUrl('https://app.smore.com/n/fnkg61/')?.issueId, 'fnkg61')
check('another host entirely is not a newsletter', parseSmoreUrl('https://example.com/n/fnkg61'), null)
check('nor is a Smore page that is not an issue', parseSmoreUrl('https://app.smore.com/app/pages/fnkg61'), null)

console.log('\n— the delete that must never widen —\n')

/* The whole reason the slug was mandatory. `%-%` is not a narrower delete than
 * `%-tca-east-elementary-news%`; it is every url in the table. */
check('an empty slug produces no pattern', supersedePattern(''), null)
check('and neither does null', supersedePattern(null), null)
check('nor undefined', supersedePattern(undefined), null)
check('a real slug produces its own range', supersedePattern('tca-east-elementary-news'), '%-tca-east-elementary-news%')

// ilike treats `_` as "any character" and `%` as "anything at all", so a slug
// carrying either is a caller widening their own delete range.
checkTrue('an underscore is refused', !isPublicationSlug('tca_east'))
checkTrue('a percent is refused', !isPublicationSlug('tca%'))
checkTrue('a leading hyphen is refused', !isPublicationSlug('-east'))
checkTrue('a double hyphen is refused', !isPublicationSlug('tca--east'))
checkTrue('two characters are too few to group on', !isPublicationSlug('ea'))
checkTrue('and a normal slug passes', isPublicationSlug('tca-east-elementary-news'))

console.log('\n— naming the publication when the URL cannot —\n')

check('a title reduces to a slug',
  publicationSlugFromTitle('TCA East Elementary News'), 'tca-east-elementary-news')
check('punctuation and doubled spaces collapse',
  publicationSlugFromTitle("TCA East — Titans'  Weekly!"), 'tca-east-titans-weekly')
check('a title that reduces to nothing is refused', publicationSlugFromTitle('!!! ???'), null)
check('and one too short to group on', publicationSlugFromTitle('K'), null)
// Long titles are cut, and the cut must not leave a trailing hyphen behind — that
// is a slug that fails its own validator.
checkTrue('a very long title still yields a valid slug',
  isPublicationSlug(publicationSlugFromTitle('The Classical Academy East Elementary Weekly Family Newsletter and Announcements')))

console.log('\n— the grade-level newsletters an issue links to —\n')

/* What this issue was sent about. Smore hosts a newsletter's attachments on the
 * same CDN as its icons, so the rule that removed "zoom_out_map" was also removing
 * the grade-level PDFs — the most useful links on the page, deleted as chrome. */
const ISSUE = `# TCA East Elementary News

## 8/15/26

Welcome back! Grade level newsletters are below.

[Kindergarten Newsletter](https://cdn.smore.com/u/files/k-news-aug.pdf)
[1st Grade Newsletter](https://cdn.smore.com/u/files/first-grade.pdf)
[2nd Grade Newsletter](https://drive.google.com/file/d/1AbCdEf/view)
[Supply list](https://www.tcatitans.org/uploads/supplies.PDF?v=2)
[zoom\\_out\\_map](https://cdn.smore.com/u/icons/zoom.png)
![User uploaded image](https://cdn.smore.com/u/photos/hero.jpg)
[Read the school calendar](https://www.tcatitans.org/calendar)`

const docs = linkedDocuments(ISSUE)
check('every grade-level document is found', docs.map(d => d.label), [
  'Kindergarten Newsletter', '1st Grade Newsletter', '2nd Grade Newsletter', 'Supply list',
])
checkTrue('a Smore-hosted PDF counts', docs.some(d => d.url.endsWith('k-news-aug.pdf')))
checkTrue('so does a Drive link with no extension', docs.some(d => d.url.includes('drive.google.com')))
checkTrue('an uppercase extension counts', docs.some(d => d.url.includes('supplies.PDF')))
checkTrue('an icon is not a document', !docs.some(d => d.url.includes('zoom.png')))
checkTrue('an embedded image is not a document', !docs.some(d => d.url.includes('hero.jpg')))
checkTrue('an ordinary page is not a document', !docs.some(d => d.url.endsWith('/calendar')))
check('the same document linked twice is one', linkedDocuments(`${ISSUE}\n${ISSUE}`).length, docs.length)
check('an issue that links nothing', linkedDocuments('# News\n\nNothing this week.'), [])

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}\n`)
process.exit(failures ? 1 : 0)
