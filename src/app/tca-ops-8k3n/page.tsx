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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 28 }}>
      <h2 style={{ fontSize: 13, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)', marginBottom: 10 }}>{title}</h2>
      {children}
    </div>
  )
}

export default function AdminDashboard() {
  useDarkBody()
  const [days, setDays] = useState(30)
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (d: number) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/stats?days=${d}`)
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      setStats(await res.json())
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount/dep-change pattern
  useEffect(() => { load(days) }, [days, load])

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
        {error && <p style={{ color: '#ff6b6b', marginTop: 24 }}>{error}</p>}

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
              {stats.contentGaps.length === 0 ? (
                <p style={{ color: 'rgba(255,255,255,0.35)', fontSize: 13 }}>No gaps in this window — every query found a solid match.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {stats.contentGaps.map(g => (
                    <div key={g.key} style={{ background: '#12182a', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '14px 18px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
                        <div style={{ fontSize: 14, fontWeight: 600 }}>{g.label} <span style={{ color: '#ff6b6b', fontWeight: 700 }}>({g.count})</span></div>
                        <code style={{ fontSize: 11, color: '#89b4f7', background: 'rgba(137,180,247,0.1)', padding: '3px 8px', borderRadius: 6 }}>{g.ingestRoute}</code>
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
