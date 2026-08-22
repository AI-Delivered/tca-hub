// Proof that the MaxPreps reader stores real statistics or nothing at all.
//
// Run with: node scripts/test-maxpreps.mjs
//
// Read this first: the HTML below is *invented*. Nobody involved in writing this
// has been able to reach maxpreps.com — the environment blocks it — so these
// fixtures prove the parser handles the shapes a stats page can take, not that
// MaxPreps emits any of them. The one that matters most is therefore not the happy
// path but the refusals: a page that is blocked, JavaScript-rendered, another
// school's, or too thin must produce a diagnosis and no stored row. Getting the
// happy path wrong costs a re-run; storing an advert as the football roster is a
// wrong answer nobody can trace.

import {
  parseStatTables, readStatsPage, statsToText, totalRows, MIN_STAT_ROWS,
} from '../src/lib/maxpreps.ts'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`}`)
}
const checkTrue = (name, actual) => check(name, actual, true)

const read = (html, status = 200, identifies = true) =>
  readStatsPage({ html, status, identifiesSchool: identifies })

// A server-rendered stats page: sections, each with a table under a heading.
const STATS_PAGE = `<html><body>
  <h1>The Classical Academy Titans Football Stats</h1>
  <h2>Passing</h2>
  <table>
    <tr><th>Player</th><th>Comp</th><th>Att</th><th>Yds</th><th>TD</th></tr>
    <tr><td>Jack Renner</td><td>84</td><td>131</td><td>1,204</td><td>14</td></tr>
    <tr><td>Owen Vance</td><td>12</td><td>19</td><td>141</td><td>1</td></tr>
    <tr><td>Ty Whitmore</td><td>0</td><td>0</td><td>0</td><td>0</td></tr>
  </table>
  <h2>Rushing</h2>
  <table>
    <tr><th>Player</th><th>Car</th><th>Yds</th><th>Avg</th><th>TD</th></tr>
    <tr><td>Miles O&#39;Dell</td><td>96</td><td>712</td><td>7.4</td><td>9</td></tr>
    <tr><td>Sam Kirby</td><td>41</td><td>288</td><td>7.0</td><td>3</td></tr>
  </table>
</body></html>`

console.log('\n— a page that carries statistics —\n')

const tables = parseStatTables(STATS_PAGE)
check('one table per section', tables.map(t => t.category), ['Passing', 'Rushing'])
check('headers are read', tables[0].headers, ['Player', 'Comp', 'Att', 'Yds', 'TD'])
check('and the players', tables[0].rows.map(r => r[0]), ['Jack Renner', 'Owen Vance'])
// A player with nothing but zeros has not played; carrying the row into an answer
// invites "who leads the team" to name him.
checkTrue('an all-zero row is dropped', !tables[0].rows.some(r => r[0] === 'Ty Whitmore'))
check('entities are decoded, not left as markup', tables[1].rows[0][0], "Miles O'Dell")
check('every row counted', totalRows(tables), 4)

const good = read(STATS_PAGE)
check('no problem is reported', good.problem, undefined)
check('and the shape is described for a dry run', [good.shape.tables, good.shape.hasEmbeddedJson], [2, false])

const text = statsToText({
  sport: 'Boys Football', season: '2026-27', tables,
  sourceUrl: 'https://www.maxpreps.com/co/colorado-springs/the-classical-academy-titans/football/stats/',
  fetchedOn: '2026-08-11',
})
checkTrue('the stored text says where it came from and when', text.includes('MaxPreps, read 2026-08-11'))
checkTrue('and links the page, so an answer can cite it', text.includes('maxpreps.com/co/colorado-springs'))
checkTrue('the categories survive', text.includes('Passing:') && text.includes('Rushing:'))
checkTrue('and a parent-readable line per player', text.includes('Jack Renner | 84 | 131 | 1,204 | 14'))

console.log('\n— the four ways it must refuse —\n')

/* Bot protection. CBS properties use it, it returns something that looks like a
 * page, and no parser change will ever get past it — so it must not be reported as
 * a parsing problem. */
const challenge = read('<html><body><h1>Just a moment...</h1><p>Checking your browser before accessing.</p></body></html>')
check('a challenge page is called blocked', challenge.problem, 'blocked')
checkTrue('and says a parser cannot fix it', challenge.detail.includes('no parser change will fix it'))
check('a 403 is blocked even with an innocent body', read('<html><body>nope</body></html>', 403).problem, 'blocked')
check('and so is a 429', read('<html>x</html>', 429).problem, 'blocked')

/* The most likely thing a server-side fetch of a modern sports site returns: the
 * shell, with the numbers shipped as JSON for the browser to render. */
const spa = read(`<html><body><div id="__next"></div>
  <script id="__NEXT_DATA__" type="application/json">{"props":{"stats":[]}}</script>
  </body></html>`)
check('an unrendered shell is called that', spa.problem, 'javascript-only')
checkTrue('and points at the JSON it can see', spa.detail.includes('ships them as JSON'))
checkTrue('which the dry run reports', spa.shape.hasEmbeddedJson)

/* MaxPreps hosts every school in the country under near-identical URLs. One wrong
 * slug returns a perfectly good stats page belonging to somebody else, and every
 * check above would pass on it. */
const otherSchool = read(STATS_PAGE.replace('The Classical Academy Titans', 'Sand Creek Scorpions'), 200, false)
check('another school\'s page is refused', otherSchool.problem, 'wrong-school')
checkTrue('before any of its numbers are read', otherSchool.tables.length === 0)
checkTrue('and it names the URL slug as the thing to check', otherSchool.detail.includes('URL slug'))

// Tables that are not statistics — a layout table, an advert, a schedule.
const noStats = read(`<html><body><h1>The Classical Academy Titans</h1>
  <table><tr><td>Sponsored</td><td>Buy tickets</td></tr></table></body></html>`)
check('a page whose tables hold no statistics', noStats.problem, 'unrecognised')
checkTrue('says how many tables it looked at', noStats.detail.includes('1 table(s)'))

console.log('\n— the thin page, which is the dangerous one —\n')

/* A half-rendered page yields one plausible row. Stored, it answers "who leads the
 * team in passing" with whatever that row happened to be — a wrong answer with a
 * citation on it, which is worse than no answer at all. */
const thin = `<html><body><h1>The Classical Academy Titans Football</h1>
  <h2>Passing</h2><table>
  <tr><th>Player</th><th>Yds</th><th>TD</th></tr>
  <tr><td>Jack Renner</td><td>1,204</td><td>14</td></tr>
  </table></body></html>`
const thinReading = read(thin)
check('it parses without complaint', thinReading.problem, undefined)
check('but carries fewer rows than a squad', totalRows(thinReading.tables), 1)
checkTrue('so the route\'s floor rejects it', totalRows(thinReading.tables) < MIN_STAT_ROWS)
check('and the floor is more than one', MIN_STAT_ROWS >= 3, true)

// Empty input must not throw, and must not look like success.
check('an empty body', read('').problem, 'javascript-only')
check('no tables, no rows', parseStatTables(''), [])

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}\n`)
process.exit(failures ? 1 : 0)
