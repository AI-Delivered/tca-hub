'use client'

import { useEffect, useState, useCallback } from 'react'

// The shared layout pins <body> to exactly one viewport tall (height: 100%
// in globals.css), so content past the fold falls back to the site's light
// background instead of this page's dark one. Paint <body>/<html> directly
// for the lifetime of this page rather than touching the shared layout.
function useDarkBody() {
  useEffect(() => {
    const prevBody = document.body.style.backgroundColor
    const prevHtml = document.documentElement.style.backgroundColor
    document.body.style.backgroundColor = '#0a0e1a'
    document.documentElement.style.backgroundColor = '#0a0e1a'
    return () => {
      document.body.style.backgroundColor = prevBody
      document.documentElement.style.backgroundColor = prevHtml
    }
  }, [])
}

interface Stats {
  days: number
  total: number
  noResultCount: number
  noResultRate: number
  thinResultCount: number
  resolvedCount: number
  avgLatency: number | null
  p95Latency: number | null
  dailyVolume: { date: string; total: number; noResults: number }[]
  topQueries: { query: string; count: number; noResultCount: number }[]
  noContextHitQueries: { query: string; count: number; noResultCount: number }[]
  noResultQueries: { query: string; created_at: string }[]
  thinQueries: { query: string; similarity: number | null; created_at: string; answer: string | null }[]
  contentGaps: { key: string; label: string; ingestRoute: string; count: number; samples: string[] }[]
  cost: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCost: number
    sonnetQueries: number
    pricedQueries: number
  }
  visits: {
    total: number
    uniqueVisitors: number
    dailyVisits: { date: string; count: number }[]
    queryRate: number | null
  }
}

const RANGES = [1, 7, 30, 90]

function fmtMoney(n: number) {
  return n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`
}

function Card({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'bad' | 'good' }) {
  return (
    <div style={{
      background: '#12182a', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12,
      padding: '16px 18px', minWidth: 150, flex: '1 1 150px',
    }}>
      <div style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: tone === 'bad' ? '#ff6b6b' : tone === 'good' ? '#5ee6a0' : '#fff' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

// Every prompt below is written to stand on its own in a fresh Claude Code session —
// it names the repo, the files that matter, and how to verify the fix, because the
// person pasting it won't have this dashboard's context in that window.
const REPO_CONTEXT = `Repo: tca-hub (Next.js App Router). Retrieval lives in src/app/api/search/route.ts — Voyage embeddings into the match_chunks RPC over Supabase table page_chunks, plus keyword anchors for staff, calendar, and athletics questions. Content is scraped by the routes under src/app/api/crawl/. Verify any change by running the dev server and calling the API directly:
curl -s -X POST http://localhost:3000/api/search -H 'Content-Type: application/json' -d '{"query":"YOUR QUERY"}'`

const FIX_STEPS = `Work out which of the two it is before changing anything:
1. Content gap — the page was never scraped. Search page_chunks for related text. If nothing's there, find the source page on tcatitans.org and extend the right ingest route.
2. Retrieval bug — the content exists but doesn't match. Fix the embedding/anchoring path in search/route.ts.
Then re-run the query above plus a few neighbouring ones (a staff question, a sports question, a calendar question) to confirm nothing else got dragged into the change.`

function emptyResultPrompt(query: string, when?: string): string {
  return `A parent asked TCA Hub this and got NO context back — the search found nothing to answer from:

  "${query}"${when ? `\n  (asked ${new Date(when).toLocaleString()})` : ''}

${REPO_CONTEXT}

${FIX_STEPS}`
}

function thinResultPrompt(query: string, similarity: number | null, answer: string | null): string {
  return `A parent asked TCA Hub this and got a weak answer — context was found but the best match only scored ${similarity != null ? similarity.toFixed(2) : 'low'} (anything under 0.55 is thin):

  "${query}"
${answer ? `\nThe answer it gave was:\n  "${answer.slice(0, 300)}"\n` : ''}
${REPO_CONTEXT}

${FIX_STEPS}`
}

function gapPrompt(label: string, ingestRoute: string, count: number, samples: string[]): string {
  return `TCA Hub's analytics grouped ${count} failing question${count === 1 ? '' : 's'} under "${label}" — the suggested fix is re-running ${ingestRoute}, but confirm that's actually the problem first.

Questions that failed:
${samples.map(s => `  - "${s}"`).join('\n')}

${REPO_CONTEXT}

${FIX_STEPS}

If it turns out the ingest route is the fix, run it and re-ask the questions above to confirm they now answer.`
}

function dashboardErrorPrompt(message: string, days: number): string {
  return `The TCA Hub admin dashboard (src/app/nerds/page.tsx) failed to load its stats:

  ${message}
  (requesting a ${days}-day window from /api/admin/stats)

The endpoint is src/app/api/admin/stats/route.ts — it reads the query_log and page_visits tables via the Supabase service-role client in src/lib/supabase.ts. Reproduce with:
curl -s "http://localhost:3000/api/admin/stats?days=${days}"

Find the cause, fix it, and confirm the dashboard renders at /nerds.`
}

function CopyPromptButton({ prompt, label = 'Copy fix prompt' }: { prompt: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt)
    } catch {
      // clipboard API needs a secure context — fall back for plain-http access
      const ta = document.createElement('textarea')
      ta.value = prompt
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={copy}
      title="Copy a self-contained prompt to paste into Claude Code"
      style={{
        background: copied ? 'rgba(94,230,160,0.12)' : 'rgba(137,180,247,0.1)',
        border: `1px solid ${copied ? 'rgba(94,230,160,0.4)' : 'rgba(137,180,247,0.3)'}`,
        color: copied ? '#5ee6a0' : '#89b4f7',
        borderRadius: 6, padding: '4px 10px', fontSize: 11, fontWeight: 500,
        cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit', transition: 'all 0.15s',
      }}
    >
      {copied ? 'Copied ✓' : label}
    </button>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 28 }}>
      <h2 style={{ fontSize: 13, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)', marginBottom: 10 }}>{title}</h2>
      {children}
    </div>
  )
}

const KEY_STORAGE = 'tca_nerds_key'

// The password is never compared here — whatever's typed is sent to the stats API,
// which is the thing actually holding the door shut. A 401 comes back as "nope".
function PasswordGate({ onUnlock }: { onUnlock: (key: string) => void }) {
  const [value, setValue] = useState('')
  const [showHint, setShowHint] = useState(false)
  const [rejected, setRejected] = useState(false)
  const [unavailable, setUnavailable] = useState('')
  const [checking, setChecking] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!value.trim() || checking) return
    setChecking(true)
    setRejected(false)
    const res = await fetch(`/api/admin/stats?days=1`, { headers: { 'x-admin-key': value } })
    setChecking(false)
    if (res.ok) {
      localStorage.setItem(KEY_STORAGE, value)
      onUnlock(value)
    } else if (res.status === 503) {
      const body = await res.json().catch(() => null)
      setUnavailable(body?.error ?? 'The dashboard is not configured.')
    } else {
      setRejected(true)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0a0e1a', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <form onSubmit={submit} style={{ width: '100%', maxWidth: 320, textAlign: 'center' }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#eaf0ff', margin: '0 0 6px' }}>Nerds only</h1>
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', margin: '0 0 18px' }}>Query analytics for TCA Hub.</p>
        <input
          type="password"
          value={value}
          onChange={e => { setValue(e.target.value); setRejected(false) }}
          placeholder="Password"
          autoFocus
          style={{
            width: '100%', background: '#12182a', color: '#eaf0ff', fontSize: 14, fontFamily: 'inherit',
            border: `1px solid ${rejected ? 'rgba(255,107,107,0.5)' : 'rgba(255,255,255,0.12)'}`,
            borderRadius: 10, padding: '11px 14px', outline: 'none',
          }}
        />
        <button
          type="submit"
          disabled={checking || !value.trim()}
          style={{
            width: '100%', marginTop: 10, background: '#2a4080', color: '#fff', fontSize: 14, fontWeight: 600,
            fontFamily: 'inherit', border: 'none', borderRadius: 10, padding: '11px 14px',
            cursor: checking || !value.trim() ? 'default' : 'pointer', opacity: checking || !value.trim() ? 0.5 : 1,
          }}
        >
          {checking ? 'Checking…' : 'Enter'}
        </button>
        {rejected && <p style={{ color: '#ff6b6b', fontSize: 12, marginTop: 10 }}>Not it.</p>}
        {unavailable && (
          <p style={{ color: '#ffb454', fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
            {unavailable}
          </p>
        )}
        <button
          type="button"
          onClick={() => setShowHint(true)}
          style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.35)', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer', marginTop: 14, textDecoration: 'underline' }}
        >
          {showHint ? 'as soon as…' : 'Hint'}
        </button>
      </form>
    </div>
  )
}

export default function AdminDashboard() {
  useDarkBody()
  const [days, setDays] = useState(30)
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // One piece of state, not two — localStorage can't be read during render without
  // a hydration mismatch, so `checked` marks the gap before the effect has run.
  const [auth, setAuth] = useState<{ checked: boolean; key: string | null }>({ checked: false, key: null })
  const adminKey = auth.key
  const setAdminKey = useCallback((key: string | null) => setAuth({ checked: true, key }), [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading persisted auth on mount
    setAuth({ checked: true, key: localStorage.getItem(KEY_STORAGE) })
  }, [])

  const load = useCallback(async (d: number, key: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/stats?days=${d}`, { headers: { 'x-admin-key': key } })
      if (res.status === 401) {
        // password changed underneath us — send them back to the gate
        localStorage.removeItem(KEY_STORAGE)
        setAdminKey(null)
        return
      }
      if (!res.ok) {
        // The API says why — 'set ADMIN_PASSWORD' is a five-second fix, and a
        // bare 'Request failed (503)' sends you reading server logs instead.
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `Request failed (${res.status})`)
      }
      setStats(await res.json())
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [setAdminKey])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount/dep-change pattern
  useEffect(() => { if (adminKey) load(days, adminKey) }, [days, load, adminKey])

  if (!auth.checked) return <div style={{ minHeight: '100vh', background: '#0a0e1a' }} />
  if (!adminKey) return <PasswordGate onUnlock={setAdminKey} />

  const maxDaily = stats ? Math.max(1, ...stats.dailyVolume.map(d => d.total)) : 1
  const maxDailyVisits = stats ? Math.max(1, ...stats.visits.dailyVisits.map(d => d.count)) : 1

  return (
    <div style={{ minHeight: '100vh', background: '#0a0e1a', color: '#eaf0ff', fontFamily: 'var(--font-geist-sans), system-ui, sans-serif', padding: '32px 24px 80px' }}>
      <div style={{ maxWidth: 980, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>TCA Hub — Query Analytics</h1>
          <div style={{ display: 'flex', gap: 6 }}>
            {RANGES.map(r => (
              <button key={r} onClick={() => setDays(r)} style={{
                padding: '6px 12px', borderRadius: 100, fontSize: 12, cursor: 'pointer',
                border: '1px solid rgba(255,255,255,0.15)',
                background: days === r ? '#b91c3a' : 'transparent',
                color: days === r ? '#fff' : 'rgba(255,255,255,0.6)',
              }}>{r}d</button>
            ))}
          </div>
        </div>

        {loading && <p style={{ color: 'rgba(255,255,255,0.4)', marginTop: 24 }}>Loading…</p>}
        {error && (
          <div style={{
            marginTop: 24, background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.3)',
            borderRadius: 12, padding: '14px 18px', display: 'flex', justifyContent: 'space-between',
            alignItems: 'center', gap: 12, flexWrap: 'wrap',
          }}>
            <p style={{ color: '#ff6b6b', margin: 0, fontSize: 13 }}>{error}</p>
            <CopyPromptButton prompt={dashboardErrorPrompt(error, days)} label="Copy fix prompt" />
          </div>
        )}

        {stats && !loading && (
          <>
            <Section title="Site visits">
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <Card label="Total visits" value={String(stats.visits.total)} sub={`last ${stats.days} days`} />
                <Card label="Unique visitors" value={String(stats.visits.uniqueVisitors)} sub="by browser, best-effort" />
                <Card
                  label="Asked something"
                  value={stats.total <= stats.visits.total && stats.visits.queryRate != null ? `${Math.min(100, stats.visits.queryRate * 100).toFixed(0)}%` : '—'}
                  sub={
                    stats.total > stats.visits.total
                      ? 'visit tracking just started — not comparable yet'
                      : `${stats.total} queries from ${stats.visits.total} visits`
                  }
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 70, background: '#12182a', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '10px 12px', marginTop: 12 }}>
                {stats.visits.dailyVisits.length === 0 && <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 12 }}>No visit data yet</span>}
                {stats.visits.dailyVisits.map(d => (
                  <div key={d.date} title={`${d.date}: ${d.count} visits`} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', minWidth: 2 }}>
                    <div style={{ background: '#2a4080', height: `${(d.count / maxDailyVisits) * 100}%`, borderRadius: '2px 2px 0 0' }} />
                  </div>
                ))}
              </div>
            </Section>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 24 }}>
              <Card label="Total queries" value={String(stats.total)} sub={`last ${stats.days} days`} />
              <Card
                label="No context found"
                value={`${(stats.noResultRate * 100).toFixed(1)}%`}
                sub={`${stats.noResultCount} of ${stats.total}`}
                tone={stats.noResultRate > 0.1 ? 'bad' : undefined}
              />
              <Card label="Thin context (<0.6 sim)" value={String(stats.thinResultCount)} sub="found something, weak match" />
              <Card label="Avg latency" value={stats.avgLatency != null ? `${(stats.avgLatency / 1000).toFixed(1)}s` : '—'} sub={stats.p95Latency != null ? `p95 ${(stats.p95Latency / 1000).toFixed(1)}s` : undefined} />
              <Card
                label="API cost"
                value={fmtMoney(stats.cost.totalCost)}
                sub={
                  stats.cost.pricedQueries < stats.total
                    ? `${stats.cost.pricedQueries} of ${stats.total} queries priced — rest predate cost logging`
                    : `${stats.cost.sonnetQueries} of ${stats.total} on Sonnet`
                }
              />
            </div>

            <Section title="Daily volume">
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 90, background: '#12182a', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '10px 12px' }}>
                {stats.dailyVolume.length === 0 && <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 12 }}>No data yet</span>}
                {stats.dailyVolume.map(d => (
                  <div key={d.date} title={`${d.date}: ${d.total} queries, ${d.noResults} no-result`} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', minWidth: 2 }}>
                    <div style={{ background: '#b91c3a', height: `${(d.noResults / maxDaily) * 100}%`, borderRadius: '2px 2px 0 0' }} />
                    <div style={{ background: '#2a4080', height: `${((d.total - d.noResults) / maxDaily) * 100}%` }} />
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
                <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#2a4080', borderRadius: 2, marginRight: 5 }} />answered</span>
                <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#b91c3a', borderRadius: 2, marginRight: 5 }} />no context found</span>
              </div>
            </Section>

            <Section title="Content gaps — where to re-scrape">
              {stats.resolvedCount > 0 && (
                <p style={{ color: '#5ee6a0', fontSize: 12, marginBottom: 10 }}>
                  {stats.resolvedCount} earlier failure{stats.resolvedCount === 1 ? '' : 's'} answered correctly since — dropped from the lists below.
                </p>
              )}
              {stats.contentGaps.length === 0 ? (
                <p style={{ color: 'rgba(255,255,255,0.35)', fontSize: 13 }}>Nothing outstanding — every failing question has since been answered.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {stats.contentGaps.map(g => (
                    <div key={g.key} style={{ background: '#12182a', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '14px 18px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
                        <div style={{ fontSize: 14, fontWeight: 600 }}>{g.label} <span style={{ color: '#ff6b6b', fontWeight: 700 }}>({g.count})</span></div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <code style={{ fontSize: 11, color: '#89b4f7', background: 'rgba(137,180,247,0.1)', padding: '3px 8px', borderRadius: 6 }}>{g.ingestRoute}</code>
                          <CopyPromptButton prompt={gapPrompt(g.label, g.ingestRoute, g.count, g.samples)} />
                        </div>
                      </div>
                      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 8, lineHeight: 1.6 }}>
                        {g.samples.map((s, i) => <span key={i}>{i > 0 && ' · '}&ldquo;{s}&rdquo;</span>)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            <Section title={`Top repeated questions (${stats.topQueries.length})`}>
              <Table
                rows={stats.topQueries}
                cols={[
                  { key: 'query', label: 'Query', render: r => r.query },
                  { key: 'count', label: 'Count', render: r => String(r.count) },
                  { key: 'noResultCount', label: 'No-context hits', render: r => r.noResultCount > 0 ? <span style={{ color: '#ff6b6b' }}>{r.noResultCount}</span> : '0' },
                ]}
              />
            </Section>

            <Section title={`Questions with no-context hits (${stats.noContextHitQueries.length})`}>
              <Table
                rows={stats.noContextHitQueries}
                cols={[
                  { key: 'query', label: 'Query', render: r => r.query },
                  { key: 'noResultCount', label: 'No-context hits', render: r => <span style={{ color: '#ff6b6b', fontWeight: 600 }}>{r.noResultCount}</span> },
                  { key: 'count', label: 'Times asked', render: r => String(r.count) },
                  { key: 'fix', label: 'Fix', render: r => <CopyPromptButton prompt={emptyResultPrompt(r.query)} label="Copy prompt" /> },
                ]}
                empty="None — no question has ever come back empty in this window."
              />
            </Section>

            <Section title={`Queries with no context found (${stats.noResultQueries.length} unique)`}>
              <Table
                rows={stats.noResultQueries}
                cols={[
                  { key: 'query', label: 'Query', render: r => r.query },
                  { key: 'created_at', label: 'When', render: r => new Date(r.created_at).toLocaleString() },
                  { key: 'fix', label: 'Fix', render: r => <CopyPromptButton prompt={emptyResultPrompt(r.query, r.created_at)} label="Copy prompt" /> },
                ]}
                empty="None — everything found some context in this window."
              />
            </Section>

            <Section title={`Thin-context queries (${stats.thinQueries.length})`}>
              <Table
                rows={stats.thinQueries}
                cols={[
                  { key: 'query', label: 'Query', render: r => r.query },
                  { key: 'similarity', label: 'Best match', render: r => r.similarity != null ? r.similarity.toFixed(2) : '—' },
                  { key: 'answer', label: 'Answer preview', render: r => <span style={{ color: 'rgba(255,255,255,0.5)' }}>{(r.answer ?? '').slice(0, 120)}</span> },
                  { key: 'fix', label: 'Fix', render: r => <CopyPromptButton prompt={thinResultPrompt(r.query, r.similarity, r.answer)} label="Copy prompt" /> },
                ]}
                empty="None — every answered query had a strong match."
              />
            </Section>
          </>
        )}
      </div>
    </div>
  )
}

function Table<T>({ rows, cols, empty }: { rows: T[]; cols: { key: string; label: string; render: (r: T) => React.ReactNode }[]; empty?: string }) {
  if (rows.length === 0) {
    return <p style={{ color: 'rgba(255,255,255,0.35)', fontSize: 13 }}>{empty ?? 'No data.'}</p>
  }
  return (
    <div style={{ background: '#12182a', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c.key} style={{ textAlign: 'left', padding: '8px 14px', color: 'rgba(255,255,255,0.4)', fontWeight: 500, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: i < rows.length - 1 ? '1px solid rgba(255,255,255,0.04)' : undefined }}>
              {cols.map(c => (
                <td key={c.key} style={{ padding: '8px 14px', verticalAlign: 'top' }}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
