'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Image from 'next/image'
import { marked } from 'marked'

marked.setOptions({ breaks: true })

const renderer = new marked.Renderer()
renderer.link = ({ href, title, text }: { href: string; title?: string | null; text: string }) =>
  `<a href="${href}" target="_blank" rel="noopener noreferrer"${title ? ` title="${title}"` : ''}>${text}</a>`
marked.use({ renderer })

const SUGGESTIONS = [
  'football schedules',
  'my spelling words',
  'the bell schedule',
  'school start dates',
  'the dress code',
  'reporting an absence',
  'basketball games',
  '3rd grade supplies',
  'the staff directory',
  'winter break dates',
  'HS parking permits',
  'school dismissal time',
  'cross country meets',
  'the student handbook',
  'spirit week dates',
  'soccer schedules',
  'lunch menu this week',
]

const DEFAULT_CHIPS = [
  'When does school start?',
  "What's the dress code?",
  'How do I report an absence?',
  'What time does school end?',
  'Staff directory',
  'School supply lists',
]

const CAMPUSES = ['Central Elementary', 'East Elementary', 'North Elementary', 'Junior High', 'High School', 'College Pathways', 'Cottage School']
const ELEMENTARY_GRADES = ['Kindergarten', '1st Grade', '2nd Grade', '3rd Grade', '4th Grade', '5th Grade', '6th Grade']
const SECONDARY_GRADES = ['7th Grade', '8th Grade', '9th Grade', '10th Grade', '11th Grade', '12th Grade']
const ALL_GRADES = [...ELEMENTARY_GRADES, ...SECONDARY_GRADES]

interface TcaUserContext {
  campuses: string[]
  grades: string[]
  onboarded: boolean
}

interface Source {
  url: string
  title: string
}

interface StaffCardData {
  name: string
  role: string
  email: string
  photo: string
  campus: string
}

interface Exchange {
  query: string
  answer: string
  sources: Source[]
  staffCard?: StaffCardData
}

function StaffCard({ card }: { card: StaffCardData }) {
  if (!card.photo) return null
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '14px',
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: '14px', padding: '14px 16px', marginBottom: '10px',
    }}>
      <img
        src={card.photo}
        alt={card.name}
        style={{ width: '72px', height: '72px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0, background: 'var(--border)' }}
        onError={e => { (e.target as HTMLImageElement).closest('[data-staff-card]')?.remove() }}
      />
      <div style={{ minWidth: 0 }}>
        <p style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '1px' }}>{card.name}</p>
        <p style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '4px' }}>{card.role} · {card.campus}</p>
        <a href={`mailto:${card.email}`} style={{ fontSize: '12px', color: 'var(--crimson)', textDecoration: 'none', fontWeight: 500 }}>{card.email}</a>
      </div>
    </div>
  )
}

function loadContext(): TcaUserContext | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem('tca_context')
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function saveContext(ctx: TcaUserContext) {
  if (typeof window === 'undefined') return
  localStorage.setItem('tca_context', JSON.stringify(ctx))
}

function inferCampusFromGrade(grade: string): string | null {
  if (['7th Grade', '8th Grade'].includes(grade)) return 'Junior High'
  if (['9th Grade', '10th Grade', '11th Grade', '12th Grade'].includes(grade)) return 'High School'
  return null
}

function buildContextPrefix(ctx: TcaUserContext): string {
  const grades = ctx.grades
  const explicitCampuses = ctx.campuses
  const inferredCampuses = grades
    .map(inferCampusFromGrade)
    .filter((c): c is string => c !== null)
  const allCampuses = [...new Set([...explicitCampuses, ...inferredCampuses])]
  const parts: string[] = []
  if (grades.length) parts.push(grades.join(', '))
  if (allCampuses.length) parts.push(`at ${allCampuses.join(' and ')}`)
  return parts.length ? `[Context: parent of a ${parts.join(' student ')}] ` : ''
}

function getTimeAwareChips(): string[] {
  try {
    const mtStr = new Date().toLocaleString('en-US', { timeZone: 'America/Denver' })
    const mt = new Date(mtStr)
    const hour = mt.getHours()
    const day = mt.getDay() // 0=Sun, 6=Sat
    // Sunday evening → week ahead
    if (day === 0 && hour >= 17) return ["What's on the calendar this week?", "Any practices this week?"]
    // Friday evening or weekend daytime → game weekend
    if (day === 5 && hour >= 15) return ["Any games this weekend?", "Friday night schedule"]
    if ((day === 6 || (day === 0 && hour < 15)) && hour < 21) return ["Any games today?", "Weekend schedule"]
    // Weekday morning → today's events
    if (hour >= 6 && hour < 11 && day >= 1 && day <= 5) return ["What's happening today?", "Any practice today?"]
    // Weekday afternoon/evening → tomorrow
    if (hour >= 14 && hour < 21 && day >= 1 && day <= 4) return ["Any events tomorrow?", "Practice tomorrow?"]
  } catch { /* ignore */ }
  return []
}

function buildPersonalizedChips(ctx: TcaUserContext | null, trending: string[]): string[] {
  const chips: string[] = []

  // Time-aware chips always go first
  chips.push(...getTimeAwareChips())

  if (ctx) {
    if (ctx.grades.length === 1) {
      chips.push(`Spelling list for ${ctx.grades[0]}`)
      chips.push(`Supply list for ${ctx.grades[0]}`)
    }
    if (ctx.campuses.length === 1) {
      chips.push(`Bell schedule at ${ctx.campuses[0]}`)
    }
  }

  for (const t of trending) {
    if (chips.length >= 4) break
    if (t.length > 40) continue
    if (!chips.some(c => c.toLowerCase() === t.toLowerCase())) chips.push(t)
  }
  for (const d of DEFAULT_CHIPS) {
    if (chips.length >= 4) break
    if (!chips.some(c => c.toLowerCase() === d.toLowerCase())) chips.push(d)
  }
  return chips.slice(0, 4)
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
        frameRef.current = setTimeout(tick, 2400)
      }
    } else if (phase === 'pause') {
      setPhase('erasing')
      frameRef.current = setTimeout(tick, 40)
    } else {
      if (displayText.length > 0) {
        setDisplayText(displayText.slice(0, -4))
        frameRef.current = setTimeout(tick, 0)
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
    <span style={{ display: 'inline-block', maxWidth: '100%', verticalAlign: 'bottom' }}>
      <span style={{ color: 'var(--crimson)' }}>{displayText}</span>
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

function PullToRefresh() {
  const [pull, setPull] = useState(0)
  const startY = useRef(0)
  const pullRef = useRef(0)
  const THRESHOLD = 80

  useEffect(() => {
    const onStart = (e: TouchEvent) => {
      if (window.scrollY === 0) startY.current = e.touches[0].clientY
      else startY.current = 0
    }
    const onMove = (e: TouchEvent) => {
      if (!startY.current) return
      const dist = e.touches[0].clientY - startY.current
      if (dist > 0) {
        const clamped = Math.min(dist * 0.45, THRESHOLD + 20)
        pullRef.current = clamped
        setPull(clamped)
      }
    }
    const onEnd = () => {
      if (pullRef.current >= THRESHOLD) {
        window.location.reload()
      } else {
        pullRef.current = 0
        setPull(0)
        startY.current = 0
      }
    }
    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: true })
    document.addEventListener('touchend', onEnd)
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
    }
  }, [])

  if (pull < 6) return null
  const progress = Math.min(pull / THRESHOLD, 1)
  const ready = pull >= THRESHOLD

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 5000,
      display: 'flex', justifyContent: 'center',
      paddingTop: `calc(env(safe-area-inset-top, 0px) + ${Math.max(pull * 0.5, 12)}px)`,
      pointerEvents: 'none',
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: '50%',
        background: ready ? 'var(--crimson)' : 'var(--navy)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        opacity: Math.min(progress * 1.5, 1),
        transform: `scale(${0.5 + progress * 0.5})`,
        transition: 'background 0.2s, transform 0.1s',
        boxShadow: '0 2px 16px rgba(0,0,0,0.2)',
      }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
          style={{ transform: `rotate(${progress * 270}deg)`, transition: 'transform 0.05s' }}>
          <path d="M8 2a6 6 0 1 0 6 6" stroke="white" strokeWidth="2" strokeLinecap="round"/>
          <path d="M14 3.5V1.5h-2" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
    </div>
  )
}

const CALENDARS = [
  {
    label: 'TCA Athletics',
    desc: 'Games, meets, and tournaments — all sports',
    ical: 'https://gobound.com/co/schools/theclassahs/calendar/ical/f4c41b333289444',
  },
  {
    label: 'East Elementary',
    desc: 'Events, holidays, and early outs for East',
    ical: 'https://www.tcatitans.org/fs/calendar-manager/events.ics?calendar_ids=9,8,3',
  },
  {
    label: 'Central Elementary',
    desc: 'Events, holidays, and early outs for Central',
    ical: 'https://www.tcatitans.org/fs/calendar-manager/events.ics?calendar_ids=2',
  },
  {
    label: 'North Elementary',
    desc: 'Events, holidays, and early outs for North',
    ical: 'https://www.tcatitans.org/fs/calendar-manager/events.ics?calendar_ids=9,5',
  },
  {
    label: 'Junior High',
    desc: 'JH events, schedules, and campus dates',
    ical: 'https://www.tcatitans.org/fs/calendar-manager/events.ics?calendar_ids=10',
  },
  {
    label: 'High School',
    desc: 'HS events, schedules, and campus dates',
    ical: 'https://www.tcatitans.org/fs/calendar-manager/events.ics?calendar_ids=12',
  },
  {
    label: 'College Pathways',
    desc: 'CP events and campus dates',
    ical: 'https://www.tcatitans.org/fs/calendar-manager/events.ics?calendar_ids=11,4',
  },
]

function CalendarPanel({ onClose }: { onClose: () => void }) {
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: '0 16px max(20px, env(safe-area-inset-bottom, 20px))' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '20px', width: '100%', maxWidth: '480px', padding: '24px 20px 28px', maxHeight: '85vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
          <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)' }}>Calendars & Schedules</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: '20px', cursor: 'pointer', padding: '0', lineHeight: 1 }}>✕</button>
        </div>
        <a
          href="https://www.tcatitans.org/calendar"
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: 'block', background: 'var(--crimson)', color: '#fff', borderRadius: '10px', padding: '11px 14px', textDecoration: 'none', marginBottom: '14px', fontSize: '13px', fontWeight: 600 }}
        >
          View full TCA calendar on tcatitans.org →
        </a>
        <p style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '14px', lineHeight: 1.5 }}>
          Subscribe to add TCA calendars directly to Apple Calendar or Google Calendar — they stay up to date automatically.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {CALENDARS.map(cal => {
            const webcal = cal.ical.replace(/^https?:/, 'webcal:')
            const google = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`
            return (
              <div key={cal.label} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 14px' }}>
                <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '2px' }}>{cal.label}</p>
                <p style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '10px' }}>{cal.desc}</p>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <a href={webcal} style={{ flex: 1, textAlign: 'center', padding: '7px 10px', borderRadius: '8px', background: 'rgba(255,255,255,0.08)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 600, textDecoration: 'none' }}>
                    Apple Calendar
                  </a>
                  <a href={google} target="_blank" rel="noopener noreferrer" style={{ flex: 1, textAlign: 'center', padding: '7px 10px', borderRadius: '8px', background: 'rgba(255,255,255,0.08)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 600, textDecoration: 'none' }}>
                    Google Calendar
                  </a>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function AddToHomePrompt() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent)
    const isStandalone = (navigator as { standalone?: boolean }).standalone === true
    const dismissed = localStorage.getItem('tca_a2hs')
    if (isIos && !isStandalone && !dismissed) {
      const t = setTimeout(() => setVisible(true), 2000)
      return () => clearTimeout(t)
    }
  }, [])

  function dismiss() {
    setVisible(false)
    localStorage.setItem('tca_a2hs', '1')
  }

  if (!visible) return null

  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 4000,
      padding: '0 16px max(20px, env(safe-area-inset-bottom, 20px))',
      animation: 'slideUp 0.35s cubic-bezier(0.4,0,0.2,1)',
    }}>
      <div style={{
        background: '#1a2d5a', borderRadius: '16px', padding: '16px 18px',
        display: 'flex', alignItems: 'flex-start', gap: '12px',
        boxShadow: '0 8px 40px rgba(0,0,0,0.3)',
      }}>
        <div style={{ flex: 1 }}>
          <p style={{ color: '#fff', fontWeight: 600, fontSize: '14px', marginBottom: '4px' }}>
            Add TCA Hub to your home screen
          </p>
          <p style={{ color: 'rgba(255,255,255,0.65)', fontSize: '13px', lineHeight: 1.45 }}>
            Tap <strong style={{ color: '#fff' }}>···</strong> in the top right corner, then <strong style={{ color: '#fff' }}>Share</strong>, then <strong style={{ color: '#fff' }}>"Add to Home Screen."</strong>
          </p>
        </div>
        <button onClick={dismiss} style={{ color: 'rgba(255,255,255,0.5)', background: 'none', border: 'none', fontSize: '20px', lineHeight: 1, cursor: 'pointer', padding: '0', flexShrink: 0, marginTop: '1px' }}>✕</button>
      </div>
    </div>
  )
}

function OnboardingModal({ onSave, onSkip }: { onSave: (ctx: TcaUserContext) => void; onSkip: () => void }) {
  const [selectedCampuses, setSelectedCampuses] = useState<string[]>([])
  const [selectedGrades, setSelectedGrades] = useState<string[]>([])

  function toggle<T>(arr: T[], val: T): T[] {
    return arr.includes(val) ? arr.filter(x => x !== val) : [...arr, val]
  }

  const chipStyle = (active: boolean): React.CSSProperties => ({
    padding: '6px 12px',
    borderRadius: '20px',
    border: `1px solid ${active ? 'var(--crimson)' : 'rgba(255,255,255,0.14)'}`,
    background: active ? 'rgba(185,28,58,0.12)' : 'rgba(255,255,255,0.04)',
    color: active ? 'var(--text-primary)' : 'var(--text-dim)',
    fontSize: '13px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.15s',
    whiteSpace: 'nowrap' as const,
  })

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}
      onClick={e => { if (e.target === e.currentTarget) onSkip() }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '16px', width: '100%', maxWidth: '480px', padding: '28px', boxShadow: '0 24px 80px rgba(0,0,0,0.5)' }}>
        <div style={{ marginBottom: '20px' }}>
          <p style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--crimson)', fontWeight: 600, marginBottom: '6px' }}>Personalize</p>
          <h2 style={{ fontSize: '18px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px' }}>Which campus are you at?</h2>
          <p style={{ fontSize: '13px', color: 'var(--text-dim)', lineHeight: 1.5 }}>Answers will be tailored to your student. You can update this anytime.</p>
        </div>

        <div style={{ marginBottom: '20px' }}>
          <p style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-dim)', fontWeight: 600, marginBottom: '10px' }}>Campus</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {CAMPUSES.map(c => (
              <button key={c} style={chipStyle(selectedCampuses.includes(c))} onClick={() => setSelectedCampuses(prev => toggle(prev, c))}>
                {c}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: '28px' }}>
          <p style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-dim)', fontWeight: 600, marginBottom: '10px' }}>Grade</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {ALL_GRADES.map(g => (
              <button key={g} style={chipStyle(selectedGrades.includes(g))} onClick={() => setSelectedGrades(prev => toggle(prev, g))}>
                {g}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={() => onSave({ campuses: selectedCampuses, grades: selectedGrades, onboarded: true })}
            style={{ flex: 1, padding: '10px 20px', borderRadius: '10px', border: 'none', background: 'var(--crimson)', color: '#fff', fontSize: '14px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Save preferences
          </button>
          <button
            onClick={onSkip}
            style={{ padding: '10px 16px', borderRadius: '10px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-dim)', fontSize: '14px', cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  )
}

function SourcesPanel({ sources }: { sources: Source[] }) {
  if (!sources.length) return null
  return (
    <div className="tca-sources-panel">
      {sources.map((source, i) => {
        const isUuidTitle = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(source.title ?? '')
        const label = (() => {
          if (source.title && !source.title.startsWith('http') && !isUuidTitle) return source.title
          try {
            const u = new URL(source.url)
            const host = u.hostname.replace('www.', '')
            const path = u.pathname.split('/').filter(Boolean)
            if (path.length <= 1) return host
            return host + '/' + path.slice(0, 2).join('/')
          } catch { return source.url }
        })()
        return (
          <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer" className="tca-source-link">
            <span className="tca-source-num">0{i + 1}</span>
            <span>{label}</span>
          </a>
        )
      })}
    </div>
  )
}

function AnswerCard({
  answer,
  sources,
  isStreaming = false,
  onClarify,
  onFollowUp,
}: {
  answer: string
  sources: Source[]
  isStreaming?: boolean
  onClarify?: (campus?: string, grade?: string) => void
  onFollowUp?: (opt: string) => void
}) {
  function getClarificationNeeds(text: string) {
    if (!text.includes('?')) return { needsCampus: false, needsGrade: false }
    const lower = text.toLowerCase()
    return {
      needsCampus: /which campus|what campus|campus\?|campus or grade/.test(lower),
      needsGrade: /which grade|what grade|grade\?|campus or grade/.test(lower),
    }
  }

  function getFollowUpOptions(text: string): string[] {
    const { needsCampus, needsGrade } = getClarificationNeeds(text)
    if (needsCampus || needsGrade || !text.includes('?')) return []
    const lower = text.toLowerCase()
    const campusMap: [string, string][] = [
      ['central', 'Central Elementary'], ['east', 'East Elementary'],
      ['north', 'North Elementary'], ['junior high', 'Junior High'],
      ['high school', 'High School'], ['college pathways', 'College Pathways'],
      ['cottage school', 'Cottage School'],
    ]
    const seen = new Set<string>()
    const results: string[] = []
    for (const [kw, label] of campusMap) {
      if (lower.includes(kw) && !seen.has(label)) { seen.add(label); results.push(label) }
    }
    return results
  }

  const { needsCampus, needsGrade } = getClarificationNeeds(answer)
  const followUpOpts = getFollowUpOptions(answer)

  const selectStyle: React.CSSProperties = {
    width: '100%', padding: '8px 36px 8px 12px', borderRadius: '8px',
    border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.07)',
    color: 'var(--text)', fontSize: '14px', fontFamily: 'inherit', cursor: 'pointer',
    appearance: 'none',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', lineHeight: '1.4',
  }

  return (
    <div className="tca-answer-card">
      <div className="tca-answer-meta">
        <div className="tca-answer-pulse" style={{ animation: isStreaming ? undefined : 'none', opacity: isStreaming ? undefined : 0.5 }} />
        <span className="tca-answer-label">{isStreaming && !answer ? 'Thinking…' : 'Answer'}</span>
      </div>

      <div className="tca-answer-body">
        {answer ? (
          <span dangerouslySetInnerHTML={{
            __html: (marked.parse(answer) as string)
              .replace(/(\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4})/g, '<a href="tel:$1">$1</a>')
          }} />
        ) : (
          <div className="tca-dots"><span /><span /><span /></div>
        )}
        {/* Streaming cursor */}
        {isStreaming && answer && (
          <span className="tca-cycle-cursor" aria-hidden="true" style={{ marginLeft: '1px' }} />
        )}
      </div>

      {/* Clarification pickers — only when not streaming */}
      {!isStreaming && onClarify && (needsCampus || needsGrade) && (
        <div style={{ margin: '0 22px 16px', paddingTop: '14px', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          {needsGrade && (
            <div style={{ flex: 1, minWidth: '140px' }}>
              <label style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', marginBottom: '5px' }}>Grade</label>
              <select style={selectStyle} defaultValue="" onChange={e => e.target.value && onClarify(undefined, e.target.value)}>
                <option value="" disabled>Select grade…</option>
                {ALL_GRADES.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
          )}
          {needsCampus && (
            <div style={{ flex: 1, minWidth: '160px' }}>
              <label style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', marginBottom: '5px' }}>Campus</label>
              <select style={selectStyle} defaultValue="" onChange={e => e.target.value && onClarify(e.target.value)}>
                <option value="" disabled>Select campus…</option>
                {CAMPUSES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          )}
        </div>
      )}

      {/* Follow-up options */}
      {!isStreaming && onFollowUp && followUpOpts.length > 0 && (
        <div className="tca-followup-panel">
          {followUpOpts.map(opt => (
            <button key={opt} className="tca-followup-chip" onClick={() => onFollowUp(opt)}>
              {opt}
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M2 6h8M8 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          ))}
        </div>
      )}

      <SourcesPanel sources={sources} />
    </div>
  )
}

export default function Home() {
  const [query, setQuery] = useState('')
  const [exchanges, setExchanges] = useState<Exchange[]>([])
  const [streamingAnswer, setStreamingAnswer] = useState('')
  const [streamingSources, setStreamingSources] = useState<Source[]>([])
  const [streamingStaffCard, setStreamingStaffCard] = useState<StaffCardData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [isFocused, setIsFocused] = useState(false)
  const [chips, setChips] = useState<string[]>(DEFAULT_CHIPS)
  const [userCtx, setUserCtx] = useState<TcaUserContext | null>(null)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [showCalendars, setShowCalendars] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const hasConversation = exchanges.length > 0 || loading || streamingAnswer !== ''
  const displayChips = buildPersonalizedChips(userCtx, chips)

  useEffect(() => {
    const ctx = loadContext()
    if (ctx) {
      setUserCtx(ctx)
    } else {
      const t = setTimeout(() => setShowOnboarding(true), 8000)
      return () => clearTimeout(t)
    }
  }, [])

  useEffect(() => {
    const STALE_MS = 30 * 60 * 1000
    const key = 'tca_last_active'
    const mark = () => sessionStorage.setItem(key, Date.now().toString())
    const check = () => {
      const last = parseInt(sessionStorage.getItem(key) ?? '0')
      if (last && Date.now() - last > STALE_MS) window.location.reload()
      mark()
    }
    mark()
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check() })
    return () => window.removeEventListener('focus', check)
  }, [])

  useEffect(() => {
    fetch('/api/trending')
      .then(r => r.json())
      .then(d => { if (d.chips?.length) setChips(d.chips) })
      .catch(() => {})
  }, [])

  function handleSaveContext(ctx: TcaUserContext) {
    saveContext(ctx)
    setUserCtx(ctx)
    setShowOnboarding(false)
  }

  function handleSkipOnboarding() {
    const ctx: TcaUserContext = { campuses: [], grades: [], onboarded: true }
    saveContext(ctx)
    setUserCtx(ctx)
    setShowOnboarding(false)
  }

  async function handleSearch(e: React.FormEvent, overrideQuery?: string) {
    e.preventDefault()
    const rawQ = (overrideQuery ?? query).trim()
    if (!rawQ || loading) return

    const ctx = userCtx ?? loadContext()
    const prefix = ctx ? buildContextPrefix(ctx) : ''
    const q = prefix + rawQ

    if (overrideQuery) setQuery(overrideQuery)

    setLoading(true)
    setError('')
    setStreamingAnswer('')
    setStreamingSources([])
    setStreamingStaffCard(null)

    // Build conversation history from prior exchanges (clean text, no context prefix)
    const history = exchanges.flatMap(ex => [
      { role: 'user' as const, content: ex.query },
      { role: 'assistant' as const, content: ex.answer },
    ])

    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, rawQuery: rawQ, history }),
      })

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? 'Search failed')
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let finalAnswer = ''
      let finalSources: Source[] = []
      let finalStaffCard: StaffCardData | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line) as { type: string; sources?: Source[]; text?: string; message?: string; staffCard?: StaffCardData }
            if (event.type === 'sources' && event.sources) {
              finalSources = event.sources
              setStreamingSources(event.sources)
            } else if (event.type === 'staffCard' && event.staffCard) {
              finalStaffCard = event.staffCard
              setStreamingStaffCard(event.staffCard)
            } else if (event.type === 'text' && event.text) {
              finalAnswer += event.text
              setStreamingAnswer(prev => prev + event.text)
            } else if (event.type === 'error') {
              setError(event.message ?? 'Something went wrong')
            }
          } catch { /* ignore malformed lines */ }
        }
      }

      if (finalAnswer) {
        setExchanges(prev => [...prev, { query: rawQ, answer: finalAnswer, sources: finalSources, staffCard: finalStaffCard ?? undefined }])
      }
      setStreamingAnswer('')
      setStreamingSources([])
      setStreamingStaffCard(null)
      setQuery('')

      setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 80)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  function handleClarification(lastQuery: string, campus?: string, grade?: string) {
    const parts = [lastQuery]
    if (grade) parts.push(`for a ${grade} student`)
    if (campus) parts.push(`at ${campus}`)
    handleSearch({ preventDefault: () => {} } as React.FormEvent, parts.join(' '))
  }

  function handleFollowUp(lastQuery: string, option: string) {
    handleSearch({ preventDefault: () => {} } as React.FormEvent, `${lastQuery} at ${option}`)
  }

  function handleSuggestionClick(text: string) {
    handleSearch({ preventDefault: () => {} } as React.FormEvent, text)
  }

  function reset() {
    setExchanges([])
    setStreamingAnswer('')
    setStreamingSources([])
    setStreamingStaffCard(null)
    setQuery('')
    setError('')
    setLoading(false)
    inputRef.current?.focus()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100svh' }}>
      <div className="tca-bg-glow" />

      <main
        style={{
          position: 'relative',
          zIndex: 1,
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: hasConversation ? 'flex-start' : 'center',
          padding: hasConversation ? '60px 20px 60px' : '0 20px',
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
            marginBottom: hasConversation ? '48px' : '0',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
            <Image
              src="/tca-logo.png"
              alt="TCA Titans"
              width={216}
              height={220}
              style={{ objectFit: 'contain', width: 'clamp(72px, 18vw, 108px)', height: 'auto' }}
              priority
            />
            <div style={{ textAlign: 'center' }}>
              <h1 style={{ fontSize: 'clamp(20px, 4.8vw, 32px)', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)', lineHeight: 1.1, marginBottom: hasConversation ? '0' : '6px' }}>
                TCA Hub
              </h1>
              {!hasConversation && (
                <p style={{ fontSize: 'clamp(15px, 3.6vw, 22px)', fontWeight: 300, color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', maxWidth: '100%', paddingRight: '24px' }}>
                  Ask about <CyclingText />
                </p>
              )}
            </div>
          </div>

          {/* Search */}
          <form onSubmit={handleSearch} className="tca-search-wrap" style={{ marginTop: hasConversation ? '0' : '8px' }}>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder={hasConversation ? 'Ask a follow-up…' : 'Ask anything about TCA…'}
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
              {loading && !streamingAnswer ? (
                <div className="tca-dots"><span /><span /><span /></div>
              ) : (
                <SearchIcon />
              )}
            </button>
          </form>

          {/* Quick links + personalization — only on home screen */}
          {!hasConversation && (
            <>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap', marginTop: '4px' }}>
                <button
                  onClick={() => setShowCalendars(true)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', borderRadius: '20px', padding: '7px 14px', color: 'var(--text-dim)', fontSize: '13px', cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s' }}
                >
                  Calendars & Schedules
                </button>
                <a
                  href="https://www.tcatitans.org/family/staff-directory"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: 'inline-flex', alignItems: 'center', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', borderRadius: '20px', padding: '7px 14px', color: 'var(--text-dim)', fontSize: '13px', textDecoration: 'none', transition: 'all 0.15s' }}
                >
                  Staff Directory
                </a>
              </div>
              {/* Placeholder for disclaimer / additional copy */}

              {/* Built with love — shown below chips on home screen */}
              <div style={{ textAlign: 'center', marginTop: '16px' }}>
                <p style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '6px', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  Built with love by a TCA family
                </p>
                <p style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '2px', lineHeight: 1.6 }}>
                  Designed with real family needs in mind to simplify everyday school life.
                </p>
                <p style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '2px', lineHeight: 1.6 }}>
                  Want something like this for your organization?
                </p>
                <p style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '10px', lineHeight: 1.5 }}>
                  We can build it.
                </p>
                <a
                  href="https://ai-delivered.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: 'inline-flex', alignItems: 'center', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', borderRadius: '20px', padding: '7px 16px', color: 'var(--text-dim)', fontSize: '12px', textDecoration: 'none', fontWeight: 500, transition: 'all 0.15s' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.color = 'var(--crimson)'; (e.currentTarget as HTMLAnchorElement).style.borderColor = 'var(--crimson)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.color = 'var(--text-dim)'; (e.currentTarget as HTMLAnchorElement).style.borderColor = 'var(--border)' }}
                >
                  ai-delivered.com →
                </a>
              </div>
            </>
          )}
        </div>

        {/* Error */}
        {error && (
          <div style={{ maxWidth: '640px', width: '100%', padding: '14px 20px', background: 'rgba(185, 28, 58, 0.06)', border: '1px solid rgba(185, 28, 58, 0.2)', borderRadius: '14px', color: 'var(--crimson)', fontSize: '14px', marginBottom: '16px' }}>
            {error}
          </div>
        )}

        {/* Conversation thread */}
        {hasConversation && (
          <div style={{ maxWidth: '640px', width: '100%', display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <button
              onClick={reset}
              style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: '13px', cursor: 'pointer', padding: '0', fontFamily: 'inherit', transition: 'color 0.15s' }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--navy)' }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-dim)' }}
            >
              ← New search
            </button>

            {/* Active streaming exchange — always at top */}
            {(loading || streamingAnswer) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {streamingStaffCard && <StaffCard card={streamingStaffCard} />}
                <AnswerCard
                  answer={streamingAnswer}
                  sources={streamingSources}
                  isStreaming={true}
                />
              </div>
            )}

            {/* Prior exchanges — newest first */}
            {[...exchanges].reverse().map((ex, i) => {
              const isNewest = i === 0 && !loading && streamingAnswer === ''
              const showLabel = exchanges.length > 1 || loading || streamingAnswer !== ''
              return (
                <div key={exchanges.length - 1 - i} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {showLabel && (
                    <p style={{ fontSize: '12px', color: 'var(--text-dim)', fontStyle: 'italic', paddingLeft: '2px' }}>
                      "{ex.query}"
                    </p>
                  )}
                  {ex.staffCard && <StaffCard card={ex.staffCard} />}
                  <AnswerCard
                    answer={ex.answer}
                    sources={ex.sources}
                    onClarify={isNewest ? (campus, grade) => handleClarification(ex.query, campus, grade) : undefined}
                    onFollowUp={isNewest ? (opt) => handleFollowUp(ex.query, opt) : undefined}
                  />
                </div>
              )
            })}

            <div ref={bottomRef} />
          </div>
        )}
      </main>

      {showOnboarding && <OnboardingModal onSave={handleSaveContext} onSkip={handleSkipOnboarding} />}
      {showCalendars && <CalendarPanel onClose={() => setShowCalendars(false)} />}
      <PullToRefresh />
      <AddToHomePrompt />

      <footer
        style={{
          position: 'relative',
          zIndex: 1,
          textAlign: 'center',
          padding: '16px 20px max(24px, env(safe-area-inset-bottom, 24px))',
          borderTop: '1px solid var(--border)',
          marginTop: '40px',
          flexShrink: 0,
        }}
      >
        {userCtx && (userCtx.campuses.length > 0 || userCtx.grades.length > 0) ? (
          <button
            onClick={() => setShowOnboarding(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: '12px', fontFamily: 'inherit', padding: '0' }}
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"><circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.3"/><path d="M5 6.5l1.5 1.5L9 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Personalized for your family · Edit
          </button>
        ) : (
          <button
            onClick={() => setShowOnboarding(true)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: '12px', fontFamily: 'inherit', padding: '0', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: '3px' }}
          >
            Personalize for your student →
          </button>
        )}
      </footer>
    </div>
  )
}
