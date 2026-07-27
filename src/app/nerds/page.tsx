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
  budget: Budget | null
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

interface Budget {
  amount: number
  since: string | null
  spent: number
  remaining: number
  perDay: number
  daysLeft: number | null
  truncated: boolean
}

interface Usage {
  configured: boolean
  error?: string
  days?: number
  scopedToKey?: boolean
  totalCost?: number
  totals?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  cacheHitRate?: number | null
  dailyCost?: { date: string; cost: number }[]
  byModel?: { model: string; input: number; output: number; cacheRead: number }[]
  cached?: boolean
}

const RANGES = [1, 7, 30, 90]

function fmtMoney(n: number) {
  return n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`
}

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function Card({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'bad' | 'good' }) {
  return (
    <div className="nerd-card">
      <div className="nerd-card-label">{label}</div>
      <div className="nerd-card-value" data-tone={tone}>{value}</div>
      {sub && <div className="nerd-card-sub">{sub}</div>}
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
      className="nerd-btn"
      data-copied={copied}
      title="Copy a self-contained prompt to paste into Claude Code"
    >
      {copied ? 'Copied ✓' : label}
    </button>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="nerd-section">
      <h2 className="nerd-section-title">{title}</h2>
      {children}
    </section>
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
    <div className="nerd" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <form onSubmit={submit} style={{ width: '100%', maxWidth: 320, textAlign: 'center' }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 6px' }}>Nerds only</h1>
        <p className="nerd-card-sub" style={{ margin: '0 0 18px' }}>Query analytics for TCA Hub.</p>
        <input
          type="password"
          value={value}
          onChange={e => { setValue(e.target.value); setRejected(false) }}
          placeholder="Password"
          autoFocus
          aria-label="Dashboard password"
          style={{
            width: '100%', background: '#12182a', color: '#eaf0ff', fontSize: 16, fontFamily: 'inherit',
            border: `1px solid ${rejected ? 'rgba(255,107,107,0.5)' : 'rgba(255,255,255,0.12)'}`,
            borderRadius: 10, padding: '11px 14px', outline: 'none',
          }}
        />
        <button
          type="submit"
          disabled={checking || !value.trim()}
          style={{
            width: '100%', marginTop: 10, background: '#2a4080', color: '#fff', fontSize: 14, fontWeight: 600,
            fontFamily: 'inherit', border: 'none', borderRadius: 10, padding: '12px 14px',
            cursor: checking || !value.trim() ? 'default' : 'pointer', opacity: checking || !value.trim() ? 0.5 : 1,
          }}
        >
          {checking ? 'Checking…' : 'Enter'}
        </button>
        {rejected && <p style={{ color: '#ff6b6b', fontSize: 12, marginTop: 10 }}>Not it.</p>}
        {unavailable && <p style={{ color: '#ffb454', fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>{unavailable}</p>}
        <button
          type="button"
          onClick={() => setShowHint(true)}
          style={{ background: 'none', border: 'none', color: '#7d8798', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer', marginTop: 14, textDecoration: 'underline' }}
        >
          {showHint ? 'as soon as…' : 'Hint'}
        </button>
      </form>
    </div>
  )
}

/* Credit burn-down.
   Anthropic has no balance endpoint — remaining credit is a Console-only
   number — so this counts down against a figure supplied via env. It answers
   "when do I run out at this rate", which is the question a balance is usually
   standing in for. Spend here ignores the range pills on purpose: credit is
   consumed once, so a remaining figure that grew when you clicked "7d" would
   be actively misleading. */
function BudgetPanel({ budget }: { budget: Budget | null }) {
  if (!budget) return null

  const pct = Math.min(100, Math.max(0, (budget.spent / budget.amount) * 100))
  const low = budget.remaining <= budget.amount * 0.2
  const runningOut = budget.daysLeft != null && budget.daysLeft < 14

  return (
    <Section title="Credit">
      <div className="nerd-gap">
        <div className="nerd-split-head" style={{ alignItems: 'baseline' }}>
          <span style={{ fontSize: 17, fontWeight: 700 }}>
            {fmtMoney(budget.spent)}
            <span style={{ color: '#98a2b4', fontWeight: 400 }}> of {fmtMoney(budget.amount)}</span>
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: low ? '#ff6b6b' : '#5ee6a0' }}>
            {fmtMoney(Math.max(0, budget.remaining))} left
          </span>
        </div>

        <div className="nerd-meter" style={{ height: 10, marginTop: 10 }}>
          <span style={{ width: `${pct}%`, background: low ? '#ff6b6b' : '#5ee6a0' }} />
        </div>

        <p className="nerd-card-sub" style={{ marginTop: 10 }}>
          {budget.perDay > 0
            ? <>Burning <strong style={{ color: '#eaf0ff' }}>{fmtMoney(budget.perDay)}/day</strong> over the last week
                {budget.daysLeft != null && (
                  <> · <strong style={{ color: runningOut ? '#ff6b6b' : '#eaf0ff' }}>
                    ~{Math.round(budget.daysLeft)} days left
                  </strong> at that rate</>
                )}
              </>
            : 'No priced queries in the last week — no burn rate to project from.'}
        </p>

        <p className="nerd-card-sub" style={{ marginTop: 6, color: '#7d8798' }}>
          Estimated from this app&rsquo;s own token logs, not Anthropic&rsquo;s billing — it misses
          retries and anything else on the same key, so treat it as a floor.
          {budget.since
            ? ` Counting from ${new Date(budget.since).toLocaleDateString()}.`
            : ' Counting all logged history — set ANTHROPIC_CREDIT_SINCE after a top-up to reset it.'}
          {budget.truncated && ' Row limit hit — spend is higher than shown.'}
        </p>
      </div>
    </Section>
  )
}

/* The Anthropic side of the ledger.
   Everything else on this page is derived from what the app logged about
   itself. This panel is the only thing here that Anthropic agrees with, which
   is exactly why it's worth the extra request: if the two costs disagree, the
   derived one is the one that's wrong. */
function UsagePanel({ usage, internalCost }: { usage: Usage | null; internalCost: number }) {
  if (!usage) return null

  if (!usage.configured) {
    return (
      <Section title="Anthropic usage">
        <div className="nerd-note">
          Not connected. Set <code>ANTHROPIC_ADMIN_KEY</code> to an{' '}
          <a href="https://platform.claude.com/settings/admin-keys" target="_blank" rel="noopener noreferrer" style={{ color: '#89b4f7' }}>
            Admin API key
          </a>{' '}
          (<code>sk-ant-admin01-…</code> — not your regular API key) to show what Anthropic actually
          billed alongside this app&rsquo;s own estimate. Optionally set{' '}
          <code>ANTHROPIC_ADMIN_API_KEY_ID</code> to the <code>apikey_…</code> id this app uses, so
          token counts cover only TCA Hub instead of the whole organization.
        </div>
      </Section>
    )
  }

  if (usage.error) {
    return (
      <Section title="Anthropic usage">
        <div className="nerd-note" data-tone="bad">{usage.error}</div>
      </Section>
    )
  }

  const t = usage.totals ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const billed = usage.totalCost ?? 0
  const maxCost = Math.max(0.0001, ...(usage.dailyCost ?? []).map(d => d.cost))
  const maxModel = Math.max(1, ...(usage.byModel ?? []).map(m => m.input + m.output))

  // Reconciliation. A gap here is a bug in our pricing table or our token
  // logging, not in Anthropic's billing — worth surfacing rather than burying.
  const drift = billed > 0 ? (internalCost - billed) / billed : null

  return (
    <Section title="Anthropic usage — what was actually billed">
      <div className="nerd-grid">
        <Card
          label="Billed (org)"
          value={fmtMoney(billed)}
          sub={`Anthropic cost report · last ${usage.days} days`}
        />
        <Card
          label="This app's estimate"
          value={fmtMoney(internalCost)}
          sub={
            drift == null
              ? 'from our own token logs'
              : `${drift >= 0 ? '+' : ''}${(drift * 100).toFixed(0)}% vs billed`
          }
          tone={drift != null && Math.abs(drift) > 0.25 ? 'bad' : undefined}
        />
        <Card
          label="Cache hit rate"
          value={usage.cacheHitRate != null ? `${(usage.cacheHitRate * 100).toFixed(0)}%` : '—'}
          sub={`${fmtTokens(t.cacheRead)} of input read from cache`}
          tone={usage.cacheHitRate != null && usage.cacheHitRate > 0.5 ? 'good' : undefined}
        />
        <Card
          label="Tokens"
          value={fmtTokens(t.input + t.cacheRead + t.output)}
          sub={`${fmtTokens(t.input + t.cacheRead)} in · ${fmtTokens(t.output)} out`}
        />
      </div>

      {(usage.dailyCost?.length ?? 0) > 0 && (
        <div className="nerd-chart" style={{ marginTop: 12 }} role="img" aria-label="Daily Anthropic cost">
          {usage.dailyCost!.map(d => (
            <div key={d.date} className="nerd-bar" title={`${d.date}: ${fmtMoney(d.cost)}`}>
              <span style={{ background: '#5ee6a0', height: `${(d.cost / maxCost) * 100}%` }} />
            </div>
          ))}
        </div>
      )}

      {(usage.byModel?.length ?? 0) > 0 && (
        <div className="nerd-split" style={{ marginTop: 14 }}>
          {usage.byModel!.map(m => (
            <div key={m.model} className="nerd-split-row">
              <div className="nerd-split-head">
                <span className="nerd-split-model">{m.model}</span>
                <span className="nerd-split-tokens">
                  {fmtTokens(m.input)} in · {fmtTokens(m.output)} out
                </span>
              </div>
              <div className="nerd-meter">
                <span style={{ width: `${((m.input + m.output) / maxModel) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="nerd-card-sub" style={{ marginTop: 12 }}>
        {usage.scopedToKey
          ? 'Token counts are scoped to this app’s API key. '
          : 'Token counts cover the whole organization — set ANTHROPIC_ADMIN_API_KEY_ID to narrow them to this app. '}
        Cost is always org-wide (Anthropic’s cost report has no per-key filter) and lags live
        traffic by a few minutes.
      </p>
    </Section>
  )
}

export default function AdminDashboard() {
  useDarkBody()
  const [days, setDays] = useState(30)
  const [stats, setStats] = useState<Stats | null>(null)
  const [usage, setUsage] = useState<Usage | null>(null)
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

  // Fetched separately so a slow or unconfigured Anthropic lookup never delays
  // the analytics the dashboard is actually for.
  const loadUsage = useCallback(async (d: number, key: string) => {
    setUsage(null)
    try {
      const res = await fetch(`/api/admin/usage?days=${d}`, { headers: { 'x-admin-key': key } })
      if (!res.ok) return
      setUsage(await res.json())
    } catch {
      // Panel simply doesn't render — not worth an error state on the page.
    }
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount/dep-change pattern
  useEffect(() => { if (adminKey) load(days, adminKey) }, [days, load, adminKey])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- as above
  useEffect(() => { if (adminKey) loadUsage(days, adminKey) }, [days, loadUsage, adminKey])

  if (!auth.checked) return <div style={{ minHeight: '100vh', background: '#0a0e1a' }} />
  if (!adminKey) return <PasswordGate onUnlock={setAdminKey} />

  const maxDaily = stats ? Math.max(1, ...stats.dailyVolume.map(d => d.total)) : 1
  const maxDailyVisits = stats ? Math.max(1, ...stats.visits.dailyVisits.map(d => d.count)) : 1

  return (
    <div className="nerd">
      <div className="nerd-shell">
        <header className="nerd-header">
          <div>
            <h1 className="nerd-title">TCA Hub — Query Analytics</h1>
            {stats && <p className="nerd-sub">{stats.total} queries · {stats.visits.total} visits · last {stats.days} days</p>}
          </div>
          <div className="nerd-ranges" role="group" aria-label="Time range">
            {RANGES.map(r => (
              <button
                key={r}
                className="nerd-pill"
                aria-pressed={days === r}
                onClick={() => setDays(r)}
              >{r}d</button>
            ))}
          </div>
        </header>

        {loading && <p className="nerd-empty">Loading…</p>}
        {error && (
          <div className="nerd-note" data-tone="bad" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span>{error}</span>
            <CopyPromptButton prompt={dashboardErrorPrompt(error, days)} label="Copy fix prompt" />
          </div>
        )}

        {stats && !loading && (
          <>
            <div className="nerd-grid">
              <Card label="Total queries" value={String(stats.total)} sub={`last ${stats.days} days`} />
              <Card
                label="No context found"
                value={`${(stats.noResultRate * 100).toFixed(1)}%`}
                sub={`${stats.noResultCount} of ${stats.total}`}
                tone={stats.noResultRate > 0.1 ? 'bad' : undefined}
              />
              <Card label="Thin context" value={String(stats.thinResultCount)} sub="found something, weak match" />
              <Card
                label="Avg latency"
                value={stats.avgLatency != null ? `${(stats.avgLatency / 1000).toFixed(1)}s` : '—'}
                sub={stats.p95Latency != null ? `p95 ${(stats.p95Latency / 1000).toFixed(1)}s` : undefined}
              />
              <Card
                label="Est. API cost"
                value={fmtMoney(stats.cost.totalCost)}
                sub={
                  stats.cost.pricedQueries < stats.total
                    ? `${stats.cost.pricedQueries} of ${stats.total} priced`
                    : `${stats.cost.sonnetQueries} of ${stats.total} on Sonnet`
                }
              />
              <Card label="Unique visitors" value={String(stats.visits.uniqueVisitors)} sub="by browser, best-effort" />
            </div>

            <BudgetPanel budget={stats.budget} />

            <Section title="Daily volume">
              <div className="nerd-chart" role="img" aria-label="Daily query volume">
                {stats.dailyVolume.length === 0 && <span className="nerd-empty">No data yet</span>}
                {stats.dailyVolume.map(d => (
                  <div key={d.date} className="nerd-bar" title={`${d.date}: ${d.total} queries, ${d.noResults} no-result`}>
                    <span style={{ background: '#b91c3a', height: `${(d.noResults / maxDaily) * 100}%` }} />
                    <span style={{ background: '#2a4080', height: `${((d.total - d.noResults) / maxDaily) * 100}%` }} />
                  </div>
                ))}
              </div>
              <div className="nerd-legend">
                <span><i className="nerd-swatch" style={{ background: '#2a4080' }} />answered</span>
                <span><i className="nerd-swatch" style={{ background: '#b91c3a' }} />no context found</span>
              </div>
            </Section>

            <Section title="Site visits">
              <div className="nerd-chart" role="img" aria-label="Daily visits">
                {stats.visits.dailyVisits.length === 0 && <span className="nerd-empty">No visit data yet</span>}
                {stats.visits.dailyVisits.map(d => (
                  <div key={d.date} className="nerd-bar" title={`${d.date}: ${d.count} visits`}>
                    <span style={{ background: '#2a4080', height: `${(d.count / maxDailyVisits) * 100}%` }} />
                  </div>
                ))}
              </div>
              <p className="nerd-card-sub" style={{ marginTop: 8 }}>
                {stats.total > stats.visits.total
                  ? 'Visit tracking started after query logging — the rate isn’t comparable yet.'
                  : `${stats.total} queries from ${stats.visits.total} visits${stats.visits.queryRate != null ? ` · ${Math.min(100, stats.visits.queryRate * 100).toFixed(0)}% asked something` : ''}`}
              </p>
            </Section>

            <UsagePanel usage={usage} internalCost={stats.cost.totalCost} />

            <Section title="Content gaps — where to re-scrape">
              {stats.resolvedCount > 0 && (
                <p style={{ color: '#5ee6a0', fontSize: 12, marginBottom: 10 }}>
                  {stats.resolvedCount} earlier failure{stats.resolvedCount === 1 ? '' : 's'} answered correctly since — dropped from the lists below.
                </p>
              )}
              {stats.contentGaps.length === 0 ? (
                <p className="nerd-empty">Nothing outstanding — every failing question has since been answered.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {stats.contentGaps.map(g => (
                    <div key={g.key} className="nerd-gap">
                      <div className="nerd-gap-head">
                        <div style={{ fontSize: 14, fontWeight: 600 }}>
                          {g.label} <span style={{ color: '#ff6b6b', fontWeight: 700 }}>({g.count})</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <code className="nerd-code">{g.ingestRoute}</code>
                          <CopyPromptButton prompt={gapPrompt(g.label, g.ingestRoute, g.count, g.samples)} />
                        </div>
                      </div>
                      <div className="nerd-card-sub" style={{ marginTop: 8 }}>
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
                  { key: 'query', label: 'Query', primary: true, render: r => r.query },
                  { key: 'count', label: 'Count', render: r => String(r.count) },
                  { key: 'noResultCount', label: 'No-context hits', render: r => r.noResultCount > 0 ? <span style={{ color: '#ff6b6b' }}>{r.noResultCount}</span> : '0' },
                ]}
              />
            </Section>

            <Section title={`Questions with no-context hits (${stats.noContextHitQueries.length})`}>
              <Table
                rows={stats.noContextHitQueries}
                cols={[
                  { key: 'query', label: 'Query', primary: true, render: r => r.query },
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
                  { key: 'query', label: 'Query', primary: true, render: r => r.query },
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
                  { key: 'query', label: 'Query', primary: true, render: r => r.query },
                  { key: 'similarity', label: 'Best match', render: r => r.similarity != null ? r.similarity.toFixed(2) : '—' },
                  { key: 'answer', label: 'Answer preview', render: r => <span style={{ color: '#98a2b4' }}>{(r.answer ?? '').slice(0, 120)}</span> },
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

interface Col<T> {
  key: string
  label: string
  /** Rendered as the row's heading on mobile rather than a labelled field. */
  primary?: boolean
  render: (r: T) => React.ReactNode
}

function Table<T>({ rows, cols, empty }: { rows: T[]; cols: Col<T>[]; empty?: string }) {
  if (rows.length === 0) return <p className="nerd-empty">{empty ?? 'No data.'}</p>

  return (
    <div className="nerd-tablewrap">
      <table className="nerd-table">
        <thead>
          <tr>{cols.map(c => <th key={c.key} scope="col">{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map(c => (
                // data-label is what the mobile layout prints in place of the
                // hidden column header — see the max-width:760px block in globals.css.
                <td key={c.key} data-label={c.label} data-primary={c.primary || undefined}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
