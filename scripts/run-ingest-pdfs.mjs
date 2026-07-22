#!/usr/bin/env node
// Run PDF ingestion locally — no Vercel timeout, parallel + batched

import { createClient } from '@supabase/supabase-js'
import { VoyageAIClient } from 'voyageai'
import { readFileSync, existsSync, appendFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKIP_FILE = resolve(__dirname, '../.pdf-skip-list.txt')

const envFile = readFileSync(resolve(__dirname, '../.env.local'), 'utf8')
for (const line of envFile.split('\n')) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/)
  if (m) process.env[m[1]] = m[2]
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })

// Import once at startup
const { PDFParse } = await import('pdf-parse')

async function extractPdfText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TCAHub/1.0)' },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('pdf') && !contentType.includes('octet-stream')) {
    throw new Error(`Not a PDF: ${contentType}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const uint8 = new Uint8Array(buf)
  const parser = new PDFParse({ data: uint8, verbosity: 0 })
  await parser.load({ data: uint8 })
  const result = await parser.getText()
  let text = typeof result === 'string' ? result : (result?.text ?? '')
  text = text.replace(/([a-z])([A-Z][a-z])/g, '$1\n$2')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

function chunkText(text, chunkSize = 1800, overlap = 200) {
  const chunks = []
  let start = 0
  while (start < text.length) {
    chunks.push(text.slice(start, start + chunkSize))
    start += chunkSize - overlap
  }
  return chunks
}

function loadSkipList() {
  if (!existsSync(SKIP_FILE)) return new Set()
  return new Set(readFileSync(SKIP_FILE, 'utf8').split('\n').filter(Boolean))
}

const skipListMutex = []
function addToSkipList(url) {
  appendFileSync(SKIP_FILE, url + '\n')
}

// Embed a batch of text strings in one Voyage API call
async function embedBatch(texts) {
  const res = await voyage.embed({
    input: texts.map(t => t.slice(0, 16000)),
    model: 'voyage-3-lite',
  })
  return res.data?.map(d => d.embedding) ?? []
}

async function processPdf(url, idx, total) {
  const shortUrl = url.slice(-12)
  const prefix = `[${idx}/${total}] ...${shortUrl}`
  try {
    const text = await extractPdfText(url)
    if (!text || text.length < 100) {
      addToSkipList(url)
      process.stdout.write(`${prefix} (skip — too short)\n`)
      return { skipped: 1, indexed: 0, errors: 0 }
    }
    const chunks = chunkText(text)
    const embeddings = await embedBatch(chunks)

    // Delete existing then bulk insert
    await supabase.from('page_chunks').delete().eq('url', url)
    const title = url.split('/').pop() || url
    const rows = chunks.map((content, i) => ({ url, title, content, embedding: embeddings[i] }))
      .filter(r => r.embedding)
    const { error } = await supabase.from('page_chunks').insert(rows)
    if (error) throw new Error(error.message)

    process.stdout.write(`${prefix} ✓ (${rows.length} chunks)\n`)
    return { skipped: 0, indexed: rows.length, errors: 0 }
  } catch (e) {
    const msg = e.message ?? ''
    if (msg.includes('Not a PDF') || msg.includes('HTTP 403') || msg.includes('HTTP 404')) {
      addToSkipList(url)
    }
    process.stdout.write(`${prefix} ✗ ${msg.slice(0, 70)}\n`)
    return { skipped: 0, indexed: 0, errors: 1 }
  }
}

async function main() {
  const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? '8')
  const BATCH = parseInt(process.env.BATCH_SIZE ?? '500')

  console.log('Fetching resource-manager URLs from indexed content...')
  const { data: rows, error: rowErr } = await supabase
    .from('page_chunks')
    .select('content')
    .ilike('content', '%resource-manager/view/%')
  if (rowErr) { console.error('Query error:', rowErr); process.exit(1) }

  const urlSet = new Set()
  for (const row of rows ?? []) {
    const matches = row.content.match(/https:\/\/www\.tcatitans\.org\/fs\/resource-manager\/view\/[a-f0-9-]+/g) ?? []
    matches.forEach(u => urlSet.add(u))
  }
  console.log(`Found ${urlSet.size} resource-manager URLs`)

  const skipList = loadSkipList()
  console.log(`Skip list: ${skipList.size} known-bad URLs`)

  console.log('Loading already-indexed URLs...')
  const indexed_urls = new Set()
  let pg = 0
  while (true) {
    const { data: batch } = await supabase.from('page_chunks').select('url').range(pg * 1000, (pg + 1) * 1000 - 1)
    if (!batch?.length) break
    batch.forEach(r => indexed_urls.add(r.url))
    if (batch.length < 1000) break
    pg++
  }
  console.log(`Already indexed: ${indexed_urls.size} chunks`)

  const toProcess = [...urlSet].filter(u => !indexed_urls.has(u) && !skipList.has(u)).slice(0, BATCH)
  console.log(`Processing ${toProcess.length} PDFs at concurrency=${CONCURRENCY}...\n`)

  if (toProcess.length === 0) { console.log('All done!'); return }

  let indexed = 0, skipped = 0, errors = 0
  let cursor = 0
  const total = toProcess.length

  // Worker pool — CONCURRENCY workers pulling from the queue
  async function worker() {
    while (true) {
      const idx = ++cursor
      if (idx > total) break
      const url = toProcess[idx - 1]
      const r = await processPdf(url, idx, total)
      indexed += r.indexed
      skipped += r.skipped
      errors += r.errors
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  console.log(`\nDone. indexed=${indexed} skipped=${skipped} errors=${errors}`)
  const remaining = [...urlSet].filter(u => !indexed_urls.has(u) && !skipList.has(u)).length - toProcess.length
  console.log(`Remaining: ~${remaining} PDFs`)
}

main().catch(e => { console.error(e); process.exit(1) })
