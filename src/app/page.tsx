'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

const SUGGESTIONS = [
  'the bell schedule',
  'how to report an absence',
  'the dress code policy',
  'school supply lists',
  'lunch information',
  'the staff directory',
  'parking permits',
  'upcoming events',
  'enrollment information',
  'school hours',
  'the student handbook',
  'high school course offerings',
  'summer reading lists',
  'when school starts',
  'board meeting agendas',
]

interface Source {
  url: string
  title: string
}

interface SearchResult {
  answer: string
  sources: Source[]
}

function CyclingText() {
  const [displayText, setDisplayText] = useState('')
  const [suggestionIndex, setSuggestionIndex] = useState(0)
  const [phase, setPhase] = useState<'typing' | 'pause' | 'erasing'>('typing')
  const frameRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const tick = useCallback(() => {
    const current = SUGGESTIONS[suggestionIndex]

    if (phase === 'typing') {
      if (displayText.length < current.length) {
        setDisplayText(current.slice(0, displayText.length + 1))
        frameRef.current = setTimeout(tick, 55)
      } else {
        setPhase('pause')
        frameRef.current = setTimeout(tick, 1800)
      }
    } else if (phase === 'pause') {
      setPhase('erasing')
      frameRef.current = setTimeout(tick, 40)
    } else {
      if (displayText.length > 0) {
        setDisplayText(displayText.slice(0, -1))
        frameRef.current = setTimeout(tick, 32)
      } else {
        setSuggestionIndex(i => (i + 1) % SUGGESTIONS.length)
        setPhase('typing')
        frameRef.current = setTimeout(tick, 300)
      }
    }
  }, [displayText, suggestionIndex, phase])

  useEffect(() => {
    frameRef.current = setTimeout(tick, 120)
    return () => { if (frameRef.current) clearTimeout(frameRef.current) }
  }, [tick])

  return (
    <span>
      <span style={{ color: 'var(--accent)' }}>{displayText}</span>
      <span className="tca-cycle-cursor" aria-hidden="true" />
    </span>
  )
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="6.5" cy="6.5" r="4.5" stroke="white" strokeWidth="1.5" />
      <path d="M10 10L13.5 13.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M2 7H12M12 7L7.5 2.5M12 7L7.5 11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function Home() {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<SearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [isFocused, setIsFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!query.trim()) return

    setLoading(true)
    setError('')
    setResult(null)

    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Search failed')
      setResult(data)
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  function handleSuggestionClick(text: string) {
    setQuery(text)
    inputRef.current?.focus()
  }

  function reset() {
    setResult(null)
    setQuery('')
    setError('')
    inputRef.current?.focus()
  }

  return (
    <>
      <div className="tca-bg-glow" />

      <main
        style={{
          position: 'relative',
          zIndex: 1,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: result || loading ? 'flex-start' : 'center',
          padding: result || loading ? '60px 20px 80px' : '0 20px',
          transition: 'justify-content 0.3s',
        }}
      >
        {/* Hero */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '24px',
            width: '100%',
            maxWidth: '640px',
            marginBottom: result || loading ? '48px' : '0',
          }}
        >
          {/* Orb + wordmark */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
            <div className="tca-orb" />
            <div style={{ textAlign: 'center' }}>
              <p
                style={{
                  fontSize: '11px',
                  letterSpacing: '0.2em',
                  textTransform: 'uppercase',
                  color: 'var(--text-dim)',
                  marginBottom: '8px',
                  fontWeight: 500,
                }}
              >
                The Classical Academy
              </p>
              <h1
                style={{
                  fontSize: 'clamp(28px, 5vw, 42px)',
                  fontWeight: 300,
                  letterSpacing: '-0.02em',
                  color: 'var(--text-primary)',
                  lineHeight: 1.15,
                }}
              >
                {result || loading ? (
                  <span style={{ fontSize: 'clamp(20px, 3vw, 28px)' }}>TCA Hub</span>
                ) : (
                  <>
                    Ask about{' '}
                    <CyclingText />
                  </>
                )}
              </h1>
            </div>
          </div>

          {/* Search */}
          <form
            onSubmit={handleSearch}
            className="tca-search-wrap"
            style={{ marginTop: result || loading ? '0' : '8px' }}
          >
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder={isFocused || query ? 'Ask anything about TCA…' : ''}
              className="tca-search-input"
              autoComplete="off"
              spellCheck={false}
              aria-label="Search TCA"
            />
            <button
              type="submit"
              disabled={loading || !query.trim()}
              className="tca-search-btn"
              aria-label="Search"
            >
              {loading ? (
                <div className="tca-dots">
                  <span /><span /><span />
                </div>
              ) : (
                <SearchIcon />
              )}
            </button>
          </form>

          {/* Quick suggestions — only when no result */}
          {!result && !loading && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '8px',
                justifyContent: 'center',
                marginTop: '4px',
              }}
            >
              {[
                'Bell schedule',
                'Report an absence',
                'Dress code',
                'School supply lists',
                'Lunch information',
                'Staff directory',
              ].map(s => (
                <button
                  key={s}
                  onClick={() => handleSuggestionClick(s)}
                  style={{
                    background: 'var(--glass)',
                    border: '1px solid var(--border)',
                    borderRadius: '100px',
                    padding: '6px 14px',
                    fontSize: '12px',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    transition: 'background 0.15s, color 0.15s, border-color 0.15s',
                    fontFamily: 'inherit',
                  }}
                  onMouseEnter={e => {
                    const el = e.currentTarget
                    el.style.background = 'var(--glass-hover)'
                    el.style.color = 'var(--text-primary)'
                    el.style.borderColor = 'rgba(255,255,255,0.15)'
                  }}
                  onMouseLeave={e => {
                    const el = e.currentTarget
                    el.style.background = 'var(--glass)'
                    el.style.color = 'var(--text-muted)'
                    el.style.borderColor = 'var(--border)'
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div
            style={{
              maxWidth: '640px',
              width: '100%',
              padding: '14px 20px',
              background: 'rgba(255, 60, 60, 0.08)',
              border: '1px solid rgba(255, 60, 60, 0.2)',
              borderRadius: '14px',
              color: '#ff8080',
              fontSize: '14px',
            }}
          >
            {error}
          </div>
        )}

        {/* Result */}
        {result && (
          <div
            ref={resultsRef}
            style={{ maxWidth: '640px', width: '100%', display: 'flex', flexDirection: 'column', gap: '16px' }}
          >
            <div className="tca-answer-card" style={{ padding: '24px 28px' }}>
              <p
                style={{
                  fontSize: '15px',
                  lineHeight: '1.75',
                  color: 'var(--text-primary)',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {result.answer}
              </p>
            </div>

            {result.sources.length > 0 && (
              <div>
                <p
                  style={{
                    fontSize: '10px',
                    letterSpacing: '0.15em',
                    textTransform: 'uppercase',
                    color: 'var(--text-dim)',
                    marginBottom: '10px',
                    fontWeight: 500,
                  }}
                >
                  Sources
                </p>
                <div
                  style={{
                    background: 'var(--glass)',
                    border: '1px solid var(--border)',
                    borderRadius: '14px',
                    padding: '4px 16px',
                  }}
                >
                  {result.sources.map(source => (
                    <a
                      key={source.url}
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="tca-source-link"
                    >
                      <ArrowIcon />
                      <span>{source.title || source.url}</span>
                    </a>
                  ))}
                </div>
              </div>
            )}

            <button
              onClick={reset}
              style={{
                alignSelf: 'flex-start',
                background: 'none',
                border: 'none',
                color: 'var(--text-dim)',
                fontSize: '13px',
                cursor: 'pointer',
                padding: '4px 0',
                fontFamily: 'inherit',
                transition: 'color 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-muted)' }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-dim)' }}
            >
              ← New search
            </button>
          </div>
        )}
      </main>
    </>
  )
}
