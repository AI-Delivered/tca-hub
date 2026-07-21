'use client'

import { useState } from 'react'

interface TestResult {
  question: string
  category: string
  pass: boolean
  answer: string
  sources: number
  ms: number
}

interface TestRun {
  passed: number
  total: number
  results: TestResult[]
}

const CATEGORY_COLORS: Record<string, string> = {
  Calendar: '#2563eb',
  Schedule: '#7c3aed',
  Policy: '#b45309',
  Contact: '#065f46',
  Enrollment: '#9f1239',
}

export default function TestPage() {
  const [secret, setSecret] = useState('')
  const [run, setRun] = useState<TestRun | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)

  async function runTests() {
    setLoading(true)
    setError('')
    setRun(null)
    try {
      const res = await fetch(`/api/test?secret=${encodeURIComponent(secret)}`)
      if (!res.ok) throw new Error('Unauthorized or server error')
      const data = await res.json()
      setRun(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }

  const score = run ? Math.round((run.passed / run.total) * 100) : null
  const scoreColor = score === null ? '#888' : score >= 80 ? '#16a34a' : score >= 50 ? '#d97706' : '#dc2626'

  return (
    <div style={{ minHeight: '100vh', background: '#f7f8fc', fontFamily: 'system-ui, sans-serif', padding: '40px 20px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>

        <div style={{ marginBottom: 32 }}>
          <p style={{ fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#8a9abc', marginBottom: 6 }}>
            TCA Hub
          </p>
          <h1 style={{ fontSize: 28, fontWeight: 300, color: '#0f1a35', margin: 0 }}>Search Quality Test</h1>
        </div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 32, alignItems: 'center' }}>
          <input
            type="password"
            placeholder="Crawl secret"
            value={secret}
            onChange={e => setSecret(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && runTests()}
            style={{
              flex: 1, padding: '12px 16px', borderRadius: 100, border: '1.5px solid #dde3f0',
              fontSize: 14, outline: 'none', background: '#fff', color: '#0f1a35',
            }}
          />
          <button
            onClick={runTests}
            disabled={loading || !secret}
            style={{
              padding: '12px 24px', borderRadius: 100, border: 'none', cursor: 'pointer',
              background: loading ? '#ccc' : 'linear-gradient(135deg, #1a2d5a 0%, #b91c3a 100%)',
              color: '#fff', fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap',
            }}
          >
            {loading ? 'Running…' : 'Run Tests'}
          </button>
        </div>

        {error && (
          <div style={{ padding: '12px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, color: '#dc2626', fontSize: 14, marginBottom: 24 }}>
            {error}
          </div>
        )}

        {loading && (
          <div style={{ textAlign: 'center', padding: 60, color: '#8a9abc', fontSize: 14 }}>
            Running {15} questions through search… this takes ~30 seconds
          </div>
        )}

        {run && (
          <>
            {/* Score header */}
            <div style={{
              background: '#fff', border: '1.5px solid #dde3f0', borderRadius: 20,
              padding: '24px 28px', marginBottom: 24, display: 'flex', alignItems: 'center', gap: 24,
            }}>
              <div style={{ fontSize: 52, fontWeight: 700, color: scoreColor, lineHeight: 1 }}>
                {score}%
              </div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 500, color: '#0f1a35' }}>
                  {run.passed} of {run.total} questions answered
                </div>
                <div style={{ fontSize: 13, color: '#8a9abc', marginTop: 4 }}>
                  {run.total - run.passed} returning blank or unhelpful responses
                </div>
              </div>
            </div>

            {/* Results list */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {run.results.map((r, i) => (
                <div
                  key={i}
                  onClick={() => setExpanded(expanded === i ? null : i)}
                  style={{
                    background: '#fff', border: `1.5px solid ${r.pass ? '#bbf7d0' : '#fecaca'}`,
                    borderRadius: 14, padding: '14px 18px', cursor: 'pointer',
                    transition: 'box-shadow 0.15s',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontSize: 18, flexShrink: 0 }}>{r.pass ? '✅' : '❌'}</span>
                    <span style={{ flex: 1, fontSize: 14, color: '#0f1a35', fontWeight: 500 }}>{r.question}</span>
                    <span style={{
                      fontSize: 11, padding: '2px 8px', borderRadius: 100, flexShrink: 0,
                      background: `${CATEGORY_COLORS[r.category]}18`,
                      color: CATEGORY_COLORS[r.category] ?? '#444',
                      fontWeight: 500,
                    }}>
                      {r.category}
                    </span>
                    <span style={{ fontSize: 12, color: '#8a9abc', flexShrink: 0 }}>{r.ms}ms</span>
                  </div>

                  {expanded === i && (
                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #f0f0f0' }}>
                      <p style={{ fontSize: 13, color: '#4a5a7a', margin: '0 0 8px', lineHeight: 1.6 }}>
                        {r.answer || '(no answer)'}
                        {r.answer.length === 200 ? '…' : ''}
                      </p>
                      <span style={{ fontSize: 12, color: '#8a9abc' }}>{r.sources} source{r.sources !== 1 ? 's' : ''}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
