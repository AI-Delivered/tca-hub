// Turning a model's answer into HTML for the page.
//
// The answer text is not trusted input. It is written by a model whose whole
// context is scraped from a third-party website, so a stray `<img onerror=…>`
// in a crawled page can travel through retrieval, into the answer, and — before
// this file existed — straight into `dangerouslySetInnerHTML`. Two independent
// defences, either of which is sufficient on its own:
//
//   1. marked is configured so it can never emit raw HTML. Raw HTML tokens are
//      escaped, link and image URLs are protocol-checked, and every attribute
//      value is escaped. Everything else marked emits is built from text it has
//      already escaped itself.
//   2. A DOMPurify pass over the result, loaded lazily so it costs nothing on
//      first paint. If it hasn't arrived yet, (1) still holds.

import { Marked, type Tokens } from 'marked'

// Only protocols a parent could plausibly need from a school answer. Anything
// else — javascript:, data:, vbscript: — becomes inert text.
const SAFE_PROTOCOL = /^(https?:|mailto:|tel:)/i

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function safeUrl(href: string | null | undefined): string | null {
  if (!href) return null
  // Control characters first — "java\nscript:alert(1)" is a real bypass.
  const normalized = href.replace(/[\u0000-\u0020\u007F]/g, '')
  if (!normalized) return null
  if (normalized.startsWith('/') || normalized.startsWith('#')) return normalized
  return SAFE_PROTOCOL.test(normalized) ? normalized : null
}

const marked = new Marked({ breaks: true, gfm: true })

marked.use({
  renderer: {
    // Raw HTML in the answer is shown as the text it is, never parsed.
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeText(text)
    },
    link({ href, title, tokens }: Tokens.Link) {
      const url = safeUrl(href)
      const label = this.parser.parseInline(tokens)
      if (!url) return label
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : ''
      return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer nofollow"${titleAttr}>${label}</a>`
    },
    // Answers have no reason to embed remote images, and an <img> is the
    // shortest path from injected markdown to a request off-site.
    image({ text, title }: Tokens.Image) {
      return escapeText(title || text || '')
    },
  },
})

type Purifier = { sanitize: (dirty: string, cfg: Record<string, unknown>) => string }
let purifier: Purifier | null = null
let purifierLoading: Promise<void> | null = null

// Kicked off after mount so DOMPurify never lands in the critical path. By the
// time a model has streamed its first sentence it has long since arrived.
export function preloadSanitizer(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (purifier) return Promise.resolve()
  purifierLoading ??= import('dompurify')
    .then(mod => { purifier = mod.default as unknown as Purifier })
    .catch(() => { /* marked hardening above still stands on its own */ })
  return purifierLoading
}

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'del', 'ul', 'ol', 'li', 'a', 'code', 'pre',
  'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody',
  'tr', 'th', 'td', 'hr', 'span',
]

// "(719) 555-0143" is a phone number a parent wants to tap, not a string.
// Done by walking text nodes rather than regex-replacing the HTML string: the
// string form used to be able to inject an <a> into the middle of an href.
const PHONE_RE = /(\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4})/g

function linkifyPhones(root: ParentNode) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const targets: Text[] = []
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node as Text
    if (!text.data || !PHONE_RE.test(text.data)) continue
    PHONE_RE.lastIndex = 0
    // Never linkify inside something that is already a link.
    if ((text.parentElement as HTMLElement | null)?.closest('a')) continue
    targets.push(text)
  }

  for (const text of targets) {
    const frag = document.createDocumentFragment()
    let last = 0
    for (const match of text.data.matchAll(PHONE_RE)) {
      const start = match.index ?? 0
      if (start > last) frag.append(text.data.slice(last, start))
      const anchor = document.createElement('a')
      anchor.href = `tel:${match[0].replace(/[^\d+]/g, '')}`
      anchor.textContent = match[0]
      frag.append(anchor)
      last = start + match[0].length
    }
    if (last < text.data.length) frag.append(text.data.slice(last))
    text.replaceWith(frag)
  }
}

/** Sanitized HTML for a model-written answer. Safe to hand to dangerouslySetInnerHTML. */
export function renderAnswer(markdown: string): string {
  if (!markdown) return ''
  const html = marked.parse(markdown, { async: false }) as string

  // Server render (and the sliver of time before DOMPurify loads): the marked
  // hardening above is the guarantee, and phone links wait for the client.
  if (typeof window === 'undefined') return html

  const template = document.createElement('template')
  template.innerHTML = purifier
    ? purifier.sanitize(html, {
        ALLOWED_TAGS,
        ALLOWED_ATTR: ['href', 'title', 'target', 'rel'],
        ALLOW_DATA_ATTR: false,
      })
    : html
  linkifyPhones(template.content)
  return template.innerHTML
}
