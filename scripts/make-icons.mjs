#!/usr/bin/env node
// Generate the app icon set — home screen, PWA, favicon.
//
// Every one of these was the school's actual Titans "T" mark. On a phone home
// screen that is indistinguishable from an app the school shipped, which is
// the same problem the footer disclaimer and the share card address. These use
// the hub mark from scripts/lib/hub-mark.mjs, in the school's colours but not
// its logo, matching public/og.png.
//
//   node scripts/make-icons.mjs

import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hubMark, PALETTE } from './lib/hub-mark.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { deep: DEEP, navy: NAVY } = PALETTE

/**
 * @param size    output pixels
 * @param inset   fraction of the canvas left clear around the mark. Android
 *                masks a "maskable" icon to a circle or squircle and can crop
 *                ~10% per side, so its mark sits well inside the safe zone; a
 *                plain icon can run closer to the edge.
 * @param radius  corner radius, 0 for full bleed (iOS and Android apply their
 *                own mask, and a pre-rounded icon would be rounded twice)
 * @param scale   stroke weight for the mark — heavier at small sizes
 */
function tile(size, { inset = 0.22, radius = 0, scale = 1 } = {}) {
  const r = (size / 2) * (1 - inset * 2)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${DEEP}"/>
      <stop offset="100%" stop-color="${NAVY}"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${radius}" fill="url(#bg)"/>
  ${hubMark(size / 2, size / 2, r, { scale })}
</svg>`
}

const targets = [
  // iOS home screen. Full bleed — iOS rounds it itself.
  ['public/apple-touch-icon.png', tile(180, { inset: 0.2 })],
  ['public/icon-192.png', tile(192, { inset: 0.2, radius: 42 })],
  ['public/icon-512.png', tile(512, { inset: 0.2, radius: 112 })],
  // Maskable: full bleed, mark pulled inside the crop-safe zone.
  ['public/icon-maskable-512.png', tile(512, { inset: 0.3 })],
  // A browser tab is a handful of pixels: fewer spokes, heavier strokes, or
  // the mark turns to grey mush.
  ['src/app/icon.png', tile(32, { inset: 0.16, radius: 6, scale: 1.35 })],
]

for (const [rel, svg] of targets) {
  await sharp(Buffer.from(svg)).png().toFile(path.join(ROOT, rel))
  console.log(`wrote ${rel}`)
}

/* favicon.ico, which sharp cannot write. An .ico may wrap a PNG directly, so
 * the container is a 6-byte header plus one 16-byte directory entry — cheaper
 * and more predictable than adding an image library for one file. */
const png = await sharp(Buffer.from(tile(32, { inset: 0.16, radius: 6, scale: 1.35 }))).png().toBuffer()
const header = Buffer.alloc(22)
header.writeUInt16LE(0, 0)          // reserved
header.writeUInt16LE(1, 2)          // type: icon
header.writeUInt16LE(1, 4)          // one image
header.writeUInt8(32, 6)            // width
header.writeUInt8(32, 7)            // height
header.writeUInt8(0, 8)             // palette size (0 = truecolour)
header.writeUInt8(0, 9)             // reserved
header.writeUInt16LE(1, 10)         // colour planes
header.writeUInt16LE(32, 12)        // bits per pixel
header.writeUInt32LE(png.length, 14)
header.writeUInt32LE(22, 18)        // offset of the image data
fs.writeFileSync(path.join(ROOT, 'src/app/favicon.ico'), Buffer.concat([header, png]))
console.log('wrote src/app/favicon.ico')
