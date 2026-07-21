'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Image from 'next/image'

const SUGGESTIONS = [
  'the bell schedule',
  'reporting an absence',
  'dress code',
  'supply lists',
  'lunch information',
  'the staff directory',
  'parking permits',
  'upcoming events',
  'enrollment',
  'school hours',
  'the handbook',
  'HS course offerings',
  'summer reading',
  'when school starts',
  'board agendas',
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
        frameRef.current = setTimeout(tick, 16)
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
      <span style={{ color: 'var(--crimson)' }}>{displayText}</span>
      <span className="tca-cycle-cursor" aria-hidden="true" />
    </span>
  )
}

function TitansT() {
  return (
    <svg width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="navyGrad" x1="36" y1="8" x2="36" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#2e4d8a" />
          <stop offset="100%" stopColor="#1a2d5a" />
        </linearGradient>
        <filter id="tShadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#1a2d5a" floodOpacity="0.22" />
        </filter>
      </defs>

      {/* Crossbar with flared ends — evoking the sword crossguard */}
      <path
        d="M7 16 L14 11 L58 11 L65 16 L65 23 L58 28 L14 28 L7 23 Z"
        fill="url(#navyGrad)"
        filter="url(#tShadow)"
      />

      {/* Vertical stem */}
      <rect x="28" y="27" width="16" height="34" rx="1.5" fill="url(#navyGrad)" filter="url(#tShadow)" />

      {/* Crimson base accent */}
      <rect x="26" y="59" width="20" height="3" rx="1.5" fill="#b91c3a" />

      {/* Highlight on crossbar top */}
      <path
        d="M14 11 L58 11 L65 16 L58 13 L14 13 L7 16 Z"
        fill="rgba(255,255,255,0.12)"
      />
    </svg>
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
            <Image
                src="/tca-logo.png"
                alt="TCA Titans"
                width={80}
                height={85}
                style={{ objectFit: 'contain', width: 'clamp(56px, 14vw, 80px)', height: 'auto' }}
                priority
              />
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
                  fontSize: 'clamp(22px, 5vw, 34px)',
                  fontWeight: 300,
                  letterSpacing: '-0.02em',
                  color: 'var(--text-primary)',
                  lineHeight: 1.2,
                  whiteSpace: 'nowrap',
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
                'When does school start?',
                "What's the dress code?",
                'How do I report an absence?',
                'What time does school end?',
                'Staff directory',
                'School supply lists',
              ].map(s => (
                <button
                  key={s}
                  onClick={() => handleSuggestionClick(s)}
                  className="tca-chip"
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
              background: 'rgba(185, 28, 58, 0.06)',
              border: '1px solid rgba(185, 28, 58, 0.2)',
              borderRadius: '14px',
              color: 'var(--crimson)',
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
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--navy)' }}
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
