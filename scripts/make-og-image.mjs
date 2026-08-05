#!/usr/bin/env node
// Generate public/og.png — the image shown when the link is shared.
//
// This used to be apple-touch-icon.png: the school's actual Titans "T" mark.
// A link preview carrying the school's logo reads as something the school
// published, which this is not. The card below uses the school's colours (it
// is a TCA tool, and should look like one) but its own mark — a speech bubble,
// for asking questions — and states plainly that it is unofficial, so the
// disclaimer travels with the link instead of living only on the page.
//
// 1200x630 rather than a 180px square because the main sharing channel is
// texts and class group chats, where a small square renders as a thumbnail
// next to a bare URL and a wide card renders as a card.
//
//   node scripts/make-og-image.mjs

import sharp from 'sharp'
import { hubMark, PALETTE } from './lib/hub-mark.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/og.png')

const { deep: DEEP, navy: NAVY } = PALETTE
const CRIMSON = '#b91c3a'

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${DEEP}"/>
      <stop offset="100%" stop-color="${NAVY}"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="630" fill="url(#bg)"/>
  <!-- A crimson rule rather than a crimson field: the school's palette, used
       as an accent, not as a reproduction of its branding. -->
  <rect x="0" y="0" width="1200" height="10" fill="${CRIMSON}"/>

  <!-- The hub mark: one centre joined to the things around it. Shared with
       the app icons via scripts/lib/hub-mark.mjs. -->
  ${hubMark(162, 292, 66)}

  <text x="280" y="292" font-family="Georgia, 'Times New Roman', serif" font-size="96"
        font-weight="700" fill="#ffffff">TCA Hub</text>

  <text x="284" y="360" font-family="Helvetica, Arial, sans-serif" font-size="35"
        fill="#c8d4ee">Schedules, staff, calendars and supply lists —</text>
  <text x="284" y="408" font-family="Helvetica, Arial, sans-serif" font-size="35"
        fill="#c8d4ee">ask a question, get a straight answer with sources.</text>

  <!-- The disclaimer, at the point the link is shared. -->
  <text x="96" y="556" font-family="Helvetica, Arial, sans-serif" font-size="27"
        fill="#8fa3ce">Unofficial · built by a TCA family · not affiliated with The Classical Academy</text>
</svg>`

await sharp(Buffer.from(svg)).png().toFile(OUT)
console.log(`wrote ${OUT}`)
