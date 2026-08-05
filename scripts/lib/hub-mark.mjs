// The app's mark: a hub — one centre joined by spokes to the things around it,
// which is what the app does with the school's scattered sources.
//
// Used by both make-icons.mjs and make-og-image.mjs so the home screen, the
// browser tab and the shared link all carry the same identity. It exists at
// all because every one of those was previously the school's Titans "T",
// which made an independent tool look like something the school shipped.

/* The app's own colours, read off the running UI rather than picked by eye.
 * --navy is constant across the light and dark themes, and --bg is what the
 * dark theme actually renders behind everything; a gradient between the two is
 * the blue a parent sees in the app. An earlier version ran up to --navy-mid
 * (#2a4080), which is a brighter blue that appears nowhere prominent and made
 * the icon look like a different product. */
export const PALETTE = {
  deep: '#0a0e1a',      // --bg, dark theme
  navy: '#1a2d5a',      // --navy, identical in both themes
  crimson: '#b91c3a',   // --crimson
}

/**
 * Hub-and-spoke mark, drawn white, centred on (cx, cy).
 *
 * @param r      radius out to the centre of the outer nodes
 * @param nodes  number of outer nodes
 * @param scale  stroke and node weight, relative to r. Small renders need
 *               heavier strokes or the spokes disappear into the background.
 */
export function hubMark(cx, cy, r, { nodes = 6, scale = 1, color = '#ffffff' } = {}) {
  const stroke = r * 0.11 * scale
  const hubR = r * 0.26 * scale
  const nodeR = r * 0.17 * scale

  const spokes = []
  const dots = []
  for (let i = 0; i < nodes; i++) {
    // Start at -90° so a node sits at the top rather than the mark looking
    // rotated by an arbitrary amount.
    const a = (Math.PI * 2 * i) / nodes - Math.PI / 2
    const x = cx + Math.cos(a) * r
    const y = cy + Math.sin(a) * r
    spokes.push(`<line x1="${cx.toFixed(2)}" y1="${cy.toFixed(2)}" x2="${x.toFixed(2)}" y2="${y.toFixed(2)}" stroke="${color}" stroke-width="${stroke.toFixed(2)}" stroke-linecap="round"/>`)
    dots.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${nodeR.toFixed(2)}" fill="${color}"/>`)
  }

  // Spokes first so the nodes and hub sit on top of the line ends.
  return `${spokes.join('')}${dots.join('')}<circle cx="${cx}" cy="${cy}" r="${hubR.toFixed(2)}" fill="${color}"/>`
}
