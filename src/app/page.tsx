'use client'

import { useState } from 'react'

interface Source {
  url: string
  title: string
}

interface SearchResult {
  answer: string
  sources: Source[]
}

export default function Home() {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<SearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-white">
      <div className="bg-[#1a3a5c] text-white py-10 px-4 text-center">
        <p className="text-sm uppercase tracking-widest text-blue-200 mb-1">The Classical Academy</p>
        <h1 className="text-3xl font-bold mb-2">TCA Hub</h1>
        <p className="text-blue-200 text-sm">Ask anything about TCA — calendars, policies, contacts, and more</p>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-10">
        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="When does school start? What's the bell schedule? How do I report an absence?"
            className="flex-1 border border-gray-300 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#1a3a5c]"
          />
          <button
            type="submit"
            disabled={loading}
            className="bg-[#1a3a5c] text-white px-5 py-3 rounded-lg text-sm font-medium hover:bg-[#142d4a] disabled:opacity-50 transition-colors"
          >
            {loading ? '...' : 'Ask'}
          </button>
        </form>

        {!result && !loading && (
          <div className="mt-6 flex flex-wrap gap-2">
            {[
              'When does school start?',
              'What are school hours?',
              'How do I report an absence?',
              'Where is the staff directory?',
              'What is the dress code?',
              'Lunch information',
            ].map(suggestion => (
              <button
                key={suggestion}
                onClick={() => setQuery(suggestion)}
                className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 py-1.5 rounded-full transition-colors"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className="mt-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {error}
          </div>
        )}

        {result && (
          <div className="mt-6 space-y-4">
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-5">
              <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{result.answer}</p>
            </div>

            {result.sources.length > 0 && (
              <div>
                <p className="text-xs text-gray-400 uppercase tracking-wider mb-2">Sources</p>
                <ul className="space-y-1">
                  {result.sources.map(source => (
                    <li key={source.url}>
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-[#1a3a5c] hover:underline"
                      >
                        {source.title || source.url}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <button
              onClick={() => { setResult(null); setQuery('') }}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              ← New search
            </button>
          </div>
        )}
      </div>
    </main>
  )
}
