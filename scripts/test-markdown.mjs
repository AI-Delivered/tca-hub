// Proof that a model answer can't put executable HTML on the page.
//
// Every case below is something a crawled page could plausibly plant in the
// knowledge base and a model could plausibly echo into an answer. Run with:
//   node scripts/test-markdown.mjs
//
// This exercises the marked layer only — the synchronous defence that holds
// even before DOMPurify has finished loading in the browser. If a case passes
// here it is safe with no DOM at all.

import { renderAnswer } from '../src/lib/markdown.ts'

// The invariant, rather than a list of strings not to contain: whatever the
// input, the emitted HTML may only use tags and attributes from this allowlist,
// and any href must carry a protocol a parent could actually need. Escaped text
// like `&lt;script&gt;` is inert and correctly passes — an earlier version of
// this file flagged it, which was the test being wrong, not the renderer.
const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'em', 'del', 'ul', 'ol', 'li', 'a', 'code', 'pre',
  'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody',
  'tr', 'th', 'td', 'hr', 'span',
])
const ALLOWED_ATTRS = new Set(['href', 'title', 'target', 'rel'])
const SAFE_PROTOCOL = /^(https?:|mailto:|tel:|\/|#)/i

/** Every allowlist violation in a rendered string. */
function violations(html) {
  const found = []
  for (const tag of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const name = tag[1].toLowerCase()
    if (!ALLOWED_TAGS.has(name)) { found.push(`disallowed tag <${name}>`); continue }
    for (const attr of tag[2].matchAll(/([a-zA-Z:@-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      const attrName = attr[1].toLowerCase()
      const value = attr[3] ?? attr[4] ?? attr[5] ?? ''
      if (!ALLOWED_ATTRS.has(attrName)) { found.push(`disallowed attribute ${attrName} on <${name}>`); continue }
      if (attrName === 'href' && !SAFE_PROTOCOL.test(value)) found.push(`unsafe href ${value}`)
    }
  }
  return found
}

const cases = [
  ['raw script tag', '<script>alert(1)</script>'],
  ['img onerror', '<img src=x onerror="alert(1)">'],
  ['svg onload', '<svg/onload=alert(1)>'],
  ['iframe', '<iframe src="https://evil.test"></iframe>'],
  ['javascript: link', '[click me](javascript:alert(1))'],
  ['JaVaScRiPt: link', '[click me](JaVaScRiPt:alert(1))'],
  ['space in protocol', '[x](java script:alert(1))'],
  ['newline in protocol', '[x](java\nscript:alert(1))'],
  ['tab in protocol', '[x](java\tscript:alert(1))'],
  ['data: url link', '[x](data:text/html,<script>alert(1)</script>)'],
  ['vbscript: link', '[x](vbscript:msgbox(1))'],
  ['attribute break-out via href', '[x](https://a.test" onmouseover="alert(1))'],
  ['attribute break-out via title', '[x](https://a.test "t\\" onmouseover=\\"alert(1)")'],
  ['markdown image', '![alt](https://evil.test/pixel.png)'],
  ['image with javascript src', '![alt](javascript:alert(1))'],
  ['event handler on inline tag', '<b onclick="alert(1)">hi</b>'],
  ['body onload', '<body onload=alert(1)>'],
  ['form action', '<form action="https://evil.test"><input name=p>'],
  ['object tag', '<object data="https://evil.test"></object>'],
  ['style import', '<style>@import "https://evil.test"</style>'],
  ['already-escaped script', '&lt;script&gt;alert(1)&lt;/script&gt;'],
  ['conditional comment', '<!--[if IE]><script>alert(1)</script><![endif]-->'],
  ['base tag', '<base href="https://evil.test/">'],
  ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.test">'],
  ['link stylesheet', '<link rel="stylesheet" href="https://evil.test/x.css">'],
  ['autolink javascript', '<javascript:alert(1)>'],
  ['reference-style javascript link', '[x][ref]\n\n[ref]: javascript:alert(1)'],
  ['entity-encoded protocol', '[x](&#106;avascript:alert(1))'],
  ['html in a code fence', '```\n<script>alert(1)</script>\n```'],
  ['html inside a table cell', '| a |\n| --- |\n| <img src=x onerror=alert(1)> |'],
]

let failed = 0
for (const [name, input] of cases) {
  const out = renderAnswer(input)
  const bad = violations(out)
  if (bad.length) {
    failed++
    console.error(`FAIL  ${name}\n      input:  ${JSON.stringify(input)}\n      output: ${out}\n      ${bad.join('\n      ')}`)
  } else {
    console.log(`ok    ${name}`)
  }
}

// The legitimate cases still have to work, or "safe" just means "broken".
const positives = [
  ['https link survives', '[Staff directory](https://www.tcatitans.org/family/staff-directory)', /<a href="https:\/\/www\.tcatitans\.org\/family\/staff-directory"/],
  ['mailto survives', '[Email](mailto:someone@tcatitans.org)', /href="mailto:someone@tcatitans\.org"/],
  ['tel survives', '[Call](tel:7195550143)', /href="tel:7195550143"/],
  ['bold survives', '**School starts at 8:00**', /<strong>School starts at 8:00<\/strong>/],
  ['list survives', '- one\n- two', /<li>one<\/li>/],
  ['links open in a new tab', '[x](https://a.test)', /rel="noopener noreferrer nofollow"/],
  ['line breaks survive', 'one\ntwo', /<br>/],
]

for (const [name, input, expected] of positives) {
  const out = renderAnswer(input)
  if (!expected.test(out)) {
    failed++
    console.error(`FAIL  ${name}\n      output: ${out}`)
  } else {
    console.log(`ok    ${name}`)
  }
}

console.log(failed ? `\n${failed} failing case(s)` : `\nAll ${cases.length + positives.length} cases pass`)
process.exit(failed ? 1 : 0)
