// Proof that another school's newsletter cannot be stored as this school's.
//
// Run with: node scripts/test-school-identity.mjs
//
// ingest-email takes a Smore URL from whoever calls it and stores the text stamped
// "the TCA campus newsletter". The mis-paste this guards against is a real one:
// searching for TCA's newsletter returns several publications called "Titan eNews",
// and at least one belongs to Academy High School — same district (Academy District
// 20), same city, same Titan branding, same platform, hosted at a URL with no slug
// in it to tell them apart. Its dates would enter the corpus in TCA's voice, and no
// amount of retrieval work downstream could catch that.

import { identifiesSchool, identityRefusal } from '../src/lib/school-identity.ts'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`}`)
}
const checkTrue = (name, actual) => check(name, actual, true)

// TCA's own, which identifies itself by name and by mailbox.
const TCA_CENTRAL = `TCA Central Newsletter — 8/8/26
The Classical Academy, 1655 Springcrest Rd, Colorado Springs.
Questions? tcacentralelementary@asd20.org
Picture Day is Thursday, August 27. Go Titans!`

// The near-miss: everything that looks like confirmation, and no name.
const OTHER_ASD20 = `Titan eNews — Weekly Campus Update
Academy High School, Colorado Springs. Excellence is our Standard.
Contact the front office at frontoffice@asd20.org
Picture Day is Tuesday, September 8. Go Titans!`

console.log('\n— what identifies this school —\n')

checkTrue('its own name', identifiesSchool(TCA_CENTRAL).identified)
check('and that is what settled it', identifiesSchool(TCA_CENTRAL).matched, [
  "the school's name", 'a TCA mailbox on the district domain',
])
checkTrue('its web domain on its own', identifiesSchool('Read more at www.tcatitans.org/calendar').identified)
checkTrue('a TCA mailbox on the district domain', identifiesSchool('email tcanorth@asd20.org').identified)
check('nothing to raise, since it was identified', identifiesSchool(TCA_CENTRAL).ambiguous, [])

console.log('\n— what does not —\n')

/* The whole point. Every marker in this newsletter reads as confirmation to
 * someone skimming, and every one of them is shared with the school next door. */
const other = identifiesSchool(OTHER_ASD20)
check('a different ASD20 school is not identified as TCA', other.identified, false)
check('and the refusal can say what it did find', other.ambiguous, [
  'Titan branding, which several ASD20 schools use',
  'the district domain, shared by every ASD20 school',
  'Colorado Springs',
])
checkTrue('the district domain alone is not enough', !identifiesSchool('reach us at frontoffice@asd20.org').identified)
checkTrue('nor is Titan branding', !identifiesSchool('Go Titans! Titan eNews, week of 8/8').identified)
checkTrue('nor is the city', !identifiesSchool('A public charter school in Colorado Springs, CO').identified)
checkTrue('nor are the bare initials', !identifiesSchool('TCA families: picture day is next week.').identified)
checkTrue('an empty page is not identified', !identifiesSchool('').identified)

console.log('\n— the refusal —\n')

check('a page that identifies itself is not refused', identityRefusal(TCA_CENTRAL, 'https://app.smore.com/n/q45fa'), '')

const refusal = identityRefusal(OTHER_ASD20, 'https://secure.smore.com/r92zm')
checkTrue('the refusal names the URL', refusal.includes('https://secure.smore.com/r92zm'))
checkTrue('says what is missing', refusal.includes('never names The Classical Academy'))
checkTrue('says what looked like confirmation', refusal.includes('Titan branding'))
checkTrue('says why that is not enough', refusal.includes('Academy District 20'))
checkTrue('and offers the override for a URL checked by hand', refusal.includes('allowUnverifiedSchool=true'))

// An empty page is a different failure with a different cause, and says so.
checkTrue('an unrendered page is described as one',
  identityRefusal('', 'https://app.smore.com/n/x').includes('did not render'))

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}\n`)
process.exit(failures ? 1 : 0)
