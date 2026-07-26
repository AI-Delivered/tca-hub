'use client'

import { useState, useEffect, useRef, useCallback, useMemo, useId, useSyncExternalStore } from 'react'
import { renderAnswer, preloadSanitizer } from '@/lib/markdown'

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
  staffCards?: StaffCardData[]
}

/* ── Saved preferences ────────────────────────────────────────────────────
   Campus and grade live in localStorage and are prepended to the question as
   a short context line. The system prompt is explicit that it must not say
   "your student" unless the parent has said which one they have — this is how
   they say it.
   ──────────────────────────────────────────────────────────────────────── */

const CONTEXT_KEY = 'tca_context'

function readContext(): TcaUserContext | null {
  try {
    const raw = localStorage.getItem(CONTEXT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<TcaUserContext>
    // Whatever is in storage is a year-old string written by an older version
    // of this file, or edited by hand. Only known campuses and grades survive.
    return {
      campuses: Array.isArray(parsed.campuses) ? parsed.campuses.filter(c => CAMPUSES.includes(c)) : [],
      grades: Array.isArray(parsed.grades) ? parsed.grades.filter(g => ALL_GRADES.includes(g)) : [],
      onboarded: parsed.onboarded === true,
    }
  } catch { return null }
}

// localStorage is an external store, so it is read as one. Reading it in an
// effect and calling setState meant an extra render on every load; a lazy
// useState initializer would have meant a hydration mismatch, because the
// server has no idea which campus this parent picked. useSyncExternalStore
// handles both: null during hydration, the stored value immediately after.
const contextListeners = new Set<() => void>()
let contextCache: TcaUserContext | null | undefined

function subscribeContext(onChange: () => void) {
  contextListeners.add(onChange)
  // Another tab changing preferences should update this one.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== CONTEXT_KEY) return
    contextCache = undefined
    contextListeners.forEach(l => l())
  }
  window.addEventListener('storage', onStorage)
  return () => {
    contextListeners.delete(onChange)
    window.removeEventListener('storage', onStorage)
  }
}

function getContextSnapshot(): TcaUserContext | null {
  if (contextCache === undefined) contextCache = readContext()
  return contextCache
}

function getContextServerSnapshot(): TcaUserContext | null {
  return null
}

function saveContext(ctx: TcaUserContext) {
  try { localStorage.setItem(CONTEXT_KEY, JSON.stringify(ctx)) } catch { /* private mode */ }
  contextCache = ctx
  contextListeners.forEach(l => l())
}

function inferCampusFromGrade(grade: string): string | null {
  if (['7th Grade', '8th Grade'].includes(grade)) return 'Junior High'
  if (['9th Grade', '10th Grade', '11th Grade', '12th Grade'].includes(grade)) return 'High School'
  return null
}

function buildContextPrefix(ctx: TcaUserContext | null): string {
  if (!ctx) return ''
  const inferred = ctx.grades.map(inferCampusFromGrade).filter((c): c is string => c !== null)
  const campuses = [...new Set([...ctx.campuses, ...inferred])]
  const parts: string[] = []
  if (ctx.grades.length) parts.push(ctx.grades.join(', '))
  if (campuses.length) parts.push(`at ${campuses.join(' and ')}`)
  return parts.length ? `[Context: parent of a ${parts.join(' student ')}] ` : ''
}

/** Chips that read the clock: on a Friday evening, offer the weekend's games. */
function getTimeAwareChips(): string[] {
  try {
    const mt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }))
    const hour = mt.getHours()
    const day = mt.getDay()
    if (day === 0 && hour >= 17) return ["What's on the calendar this week?", 'Any practices this week?']
    if (day === 5 && hour >= 15) return ['Any games this weekend?', 'Friday night schedule']
    if ((day === 6 || (day === 0 && hour < 15)) && hour < 21) return ['Any games today?', 'Weekend schedule']
    if (hour >= 6 && hour < 11 && day >= 1 && day <= 5) return ["What's happening today?", 'Any practice today?']
    if (hour >= 14 && hour < 21 && day >= 1 && day <= 4) return ['Any events tomorrow?', 'Practice tomorrow?']
  } catch { /* exotic locale */ }
  return []
}

function buildPersonalizedChips(ctx: TcaUserContext | null, trending: string[]): string[] {
  const chips: string[] = [...getTimeAwareChips()]

  if (ctx?.grades.length === 1) {
    chips.push(`Supply list for ${ctx.grades[0]}`)
  }
  if (ctx?.campuses.length === 1) {
    chips.push(`Bell schedule at ${ctx.campuses[0]}`)
  }

  const add = (candidate: string) => {
    if (chips.length >= 4) return
    if (candidate.length > 42) return
    if (chips.some(c => c.toLowerCase() === candidate.toLowerCase())) return
    chips.push(candidate)
  }
  trending.forEach(add)
  DEFAULT_CHIPS.forEach(add)
  return chips.slice(0, 4)
}

/* ── Small pieces ─────────────────────────────────────────────────────── */

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return ((parts[0][0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

function StaffCard({ card, compact }: { card: StaffCardData; compact: boolean }) {
  // ~12% of the directory has a placeholder image instead of a headshot — the
  // High School principal among them. A monogram keeps the card (role, campus,
  // email) rather than making those people disappear from results.
  const [imageBroken, setImageBroken] = useState(false)
  const size = compact ? 56 : 72
  const showPhoto = Boolean(card.photo) && !imageBroken

  return (
    <div className="tca-staff-card" data-staff-card>
      {showPhoto ? (
        // Intrinsic size is set so the card doesn't reflow when the headshot
        // arrives, and the load is deferred — a grade level's worth of teachers
        // is six photos below the fold.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="tca-staff-photo"
          src={card.photo}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setImageBroken(true)}
        />
      ) : (
        <div className="tca-staff-monogram" aria-hidden="true">{initials(card.name)}</div>
      )}
      <div className="tca-staff-text">
        <p className="tca-staff-name">{card.name}</p>
        <p className="tca-staff-role">{card.role} · {card.campus}</p>
        {card.email && <a className="tca-staff-email" href={`mailto:${card.email}`}>{card.email}</a>}
      </div>
    </div>
  )
}

// One card gets the full width; several tile into a responsive grid.
function StaffCards({ cards }: { cards: StaffCardData[] }) {
  if (!cards.length) return null
  const compact = cards.length > 1
  return (
    <div className="tca-staff-grid" data-compact={compact}>
      {cards.map(card => (
        <StaffCard key={`${card.name}|${card.campus}`} card={card} compact={compact} />
      ))}
    </div>
  )
}

/** The typing headline. One self-scheduling timer driven by refs, so a
 *  character does not re-create the effect, the callback and the timeout. */
function CyclingText() {
  const [text, setText] = useState('')
  const state = useRef({ index: 0, chars: 0, phase: 'typing' as 'typing' | 'pause' | 'erasing' })

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>

    // Reduced motion gets the phrase, not the typewriter.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      timer = setTimeout(() => setText(SUGGESTIONS[0]), 0)
      return () => clearTimeout(timer)
    }

    const tick = () => {
      const s = state.current
      const word = SUGGESTIONS[s.index]
      let delay = 55

      if (s.phase === 'typing') {
        if (s.chars < word.length) s.chars++
        else { s.phase = 'pause'; delay = 2400 }
      } else if (s.phase === 'pause') {
        s.phase = 'erasing'
        delay = 40
      } else if (s.chars > 0) {
        s.chars = Math.max(0, s.chars - 4)
        delay = 16
      } else {
        s.index = (s.index + 1) % SUGGESTIONS.length
        s.phase = 'typing'
        delay = 300
      }

      setText(word.slice(0, s.chars))
      timer = setTimeout(tick, delay)
    }

    timer = setTimeout(tick, 120)
    return () => clearTimeout(timer)
  }, [])

  return (
    <span style={{ display: 'inline-block', maxWidth: '100%', verticalAlign: 'bottom' }}>
      <span style={{ color: 'var(--crimson)' }}>{text}</span>
      <span className="tca-cycle-cursor" aria-hidden="true" />
    </span>
  )
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 10L13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** Escape closes, focus moves in and comes back, and the rest of the page is
 *  hidden from assistive technology while the dialog is open. */
function useDialog(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const node = ref.current
    node?.querySelector<HTMLElement>('[data-autofocus], button, [href], input, select')?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
      if (e.key !== 'Tab' || !node) return

      const focusable = [...node.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter(el => !el.hasAttribute('disabled'))
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }

    document.addEventListener('keydown', onKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
      previouslyFocused?.focus?.()
    }
  }, [onClose])

  return ref
}

const CALENDARS = [
  { label: 'TCA Athletics', desc: 'Games, meets, and tournaments — all sports', ical: 'https://gobound.com/co/schools/theclassahs/calendar/ical/f4c41b333289444' },
  { label: 'East Elementary', desc: 'Events, holidays, and early outs for East', ical: 'https://www.tcatitans.org/fs/calendar-manager/events.ics?calendar_ids=9,8,3' },
  { label: 'Central Elementary', desc: 'Events, holidays, and early outs for Central', ical: 'https://www.tcatitans.org/fs/calendar-manager/events.ics?calendar_ids=2' },
  { label: 'North Elementary', desc: 'Events, holidays, and early outs for North', ical: 'https://www.tcatitans.org/fs/calendar-manager/events.ics?calendar_ids=9,5' },
  { label: 'Junior High', desc: 'JH events, schedules, and campus dates', ical: 'https://www.tcatitans.org/fs/calendar-manager/events.ics?calendar_ids=10' },
  { label: 'High School', desc: 'HS events, schedules, and campus dates', ical: 'https://www.tcatitans.org/fs/calendar-manager/events.ics?calendar_ids=12' },
  { label: 'College Pathways', desc: 'CP events and campus dates', ical: 'https://www.tcatitans.org/fs/calendar-manager/events.ics?calendar_ids=11,4' },
]

function CalendarPanel({ onClose }: { onClose: () => void }) {
  const ref = useDialog(onClose)
  const titleId = useId()

  return (
    <div className="tca-scrim" data-align="bottom" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="tca-dialog" ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="tca-dialog-head">
          <h2 className="tca-dialog-title" id={titleId}>Calendars &amp; Schedules</h2>
          <button className="tca-dialog-close" onClick={onClose} aria-label="Close calendars" data-autofocus>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M4.5 4.5l9 9M13.5 4.5l-9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <a
          className="tca-btn-primary"
          style={{ display: 'block', textAlign: 'center', textDecoration: 'none', marginBottom: 14 }}
          href="https://www.tcatitans.org/calendar"
          target="_blank"
          rel="noopener noreferrer"
        >
          View the full TCA calendar →
        </a>

        <p className="tca-dialog-sub" style={{ marginBottom: 14 }}>
          Subscribe to add a TCA calendar to Apple Calendar or Google Calendar — it stays up to date on its own.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {CALENDARS.map(cal => {
            const webcal = cal.ical.replace(/^https?:/, 'webcal:')
            const google = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`
            return (
              <div className="tca-cal-row" key={cal.label}>
                <p className="tca-staff-name" style={{ fontSize: 14, fontWeight: 600 }}>{cal.label}</p>
                <p className="tca-staff-role" style={{ marginBottom: 10 }}>{cal.desc}</p>
                <div className="tca-cal-actions">
                  <a className="tca-cal-btn" href={webcal}>Apple Calendar</a>
                  <a className="tca-cal-btn" href={google} target="_blank" rel="noopener noreferrer">Google Calendar</a>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function PreferencesPanel({ initial, onSave, onClose }: {
  initial: TcaUserContext | null
  onSave: (ctx: TcaUserContext) => void
  onClose: () => void
}) {
  const ref = useDialog(onClose)
  const titleId = useId()
  const [campuses, setCampuses] = useState<string[]>(initial?.campuses ?? [])
  const [grades, setGrades] = useState<string[]>(initial?.grades ?? [])

  const toggle = <T,>(arr: T[], val: T): T[] => (arr.includes(val) ? arr.filter(x => x !== val) : [...arr, val])

  return (
    <div className="tca-scrim" data-align="center" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="tca-dialog" ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="tca-dialog-head">
          <div>
            <h2 className="tca-dialog-title" id={titleId}>Who are you asking for?</h2>
            <p className="tca-dialog-sub">
              Answers get tailored to your student&apos;s campus and grade. Saved on this device only, and you can change it any time.
            </p>
          </div>
          <button className="tca-dialog-close" onClick={onClose} aria-label="Close preferences">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M4.5 4.5l9 9M13.5 4.5l-9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <fieldset style={{ border: 0, padding: 0, margin: '0 0 20px' }}>
          <legend className="tca-field-label">Campus</legend>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {CAMPUSES.map(c => (
              <button
                key={c}
                type="button"
                className="tca-toggle"
                aria-pressed={campuses.includes(c)}
                onClick={() => setCampuses(prev => toggle(prev, c))}
              >
                {c}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset style={{ border: 0, padding: 0, margin: '0 0 26px' }}>
          <legend className="tca-field-label">Grade</legend>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {ALL_GRADES.map(g => (
              <button
                key={g}
                type="button"
                className="tca-toggle"
                aria-pressed={grades.includes(g)}
                onClick={() => setGrades(prev => toggle(prev, g))}
              >
                {g}
              </button>
            ))}
          </div>
        </fieldset>

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            className="tca-btn-primary"
            style={{ flex: 1 }}
            onClick={() => onSave({ campuses, grades, onboarded: true })}
          >
            Save
          </button>
          {(campuses.length > 0 || grades.length > 0) && (
            <button
              className="tca-btn-secondary"
              onClick={() => { setCampuses([]); setGrades([]); onSave({ campuses: [], grades: [], onboarded: true }) }}
            >
              Clear
            </button>
          )}
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
    if (!isIos || isStandalone) return
    try { if (localStorage.getItem('tca_a2hs')) return } catch { return }
    const t = setTimeout(() => setVisible(true), 4000)
    return () => clearTimeout(t)
  }, [])

  if (!visible) return null

  function dismiss() {
    setVisible(false)
    try { localStorage.setItem('tca_a2hs', '1') } catch { /* private mode */ }
  }

  return (
    <div className="tca-a2hs" role="complementary" aria-label="Install TCA Hub">
      <div className="tca-a2hs-inner">
        <div style={{ flex: 1 }}>
          <p style={{ color: '#fff', fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
            Add TCA Hub to your home screen
          </p>
          <p style={{ color: 'rgba(255,255,255,0.78)', fontSize: 13, lineHeight: 1.45 }}>
            Tap <strong style={{ color: '#fff' }}>Share</strong> at the bottom of the screen, then{' '}
            <strong style={{ color: '#fff' }}>Add to Home Screen</strong>.
          </p>
        </div>
        <button
          onClick={dismiss}
          aria-label="Dismiss"
          style={{ color: 'rgba(255,255,255,0.7)', background: 'none', border: 'none', cursor: 'pointer', padding: 4, flexShrink: 0 }}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path d="M4.5 4.5l9 9M13.5 4.5l-9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
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
            return path.length <= 1 ? host : `${host}/${path.slice(0, 2).join('/')}`
          } catch { return source.url }
        })()
        return (
          <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer" className="tca-source-link">
            <span className="tca-source-num" aria-hidden="true">0{i + 1}</span>
            <span>{label}</span>
          </a>
        )
      })}
    </div>
  )
}

function CopyAnswerButton({ answer }: { answer: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(answer)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard blocked — nothing useful to say about it */ }
  }

  return (
    <button className="tca-icon-btn" onClick={copy} aria-live="polite">
      {copied ? 'Copied' : 'Copy'}
    </button>
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
  // Parsing markdown is not free, and this used to run on every streamed token —
  // a full re-parse and re-sanitise of the whole answer, dozens of times a
  // second, while the text was still growing.
  const html = useMemo(() => renderAnswer(answer), [answer])

  const { needsCampus, needsGrade } = useMemo(() => {
    if (!answer.includes('?')) return { needsCampus: false, needsGrade: false }
    const lower = answer.toLowerCase()
    return {
      needsCampus: /which campus|what campus|campus\?|campus or grade/.test(lower),
      needsGrade: /which grade|what grade|grade\?|campus or grade/.test(lower),
    }
  }, [answer])

  const followUpOpts = useMemo(() => {
    if (needsCampus || needsGrade || !answer.includes('?')) return []
    const lower = answer.toLowerCase()
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
  }, [answer, needsCampus, needsGrade])

  return (
    <div className="tca-answer-card" data-streaming={isStreaming}>
      <div className="tca-answer-meta">
        <div className="tca-answer-pulse" />
        <span className="tca-answer-label">{isStreaming && !answer ? 'Thinking…' : 'Answer'}</span>
      </div>

      {/* The answer is announced once it settles rather than character by
          character, which is why this is polite and not assertive. */}
      <div className="tca-answer-body" aria-live="polite" aria-busy={isStreaming}>
        {answer ? (
          <span dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <span className="tca-dots" role="status" aria-label="Thinking"><span /><span /><span /></span>
        )}
        {isStreaming && answer && <span className="tca-cycle-cursor" aria-hidden="true" style={{ marginLeft: 1 }} />}
      </div>

      {!isStreaming && answer && (
        <div className="tca-answer-actions">
          <CopyAnswerButton answer={answer} />
        </div>
      )}

      {!isStreaming && onClarify && (needsCampus || needsGrade) && (
        <div className="tca-clarify">
          {needsGrade && (
            <div>
              <label htmlFor="clarify-grade">Grade</label>
              <select id="clarify-grade" className="tca-select" defaultValue="" onChange={e => e.target.value && onClarify(undefined, e.target.value)}>
                <option value="" disabled>Select grade…</option>
                {ALL_GRADES.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
          )}
          {needsCampus && (
            <div>
              <label htmlFor="clarify-campus">Campus</label>
              <select id="clarify-campus" className="tca-select" defaultValue="" onChange={e => e.target.value && onClarify(e.target.value)}>
                <option value="" disabled>Select campus…</option>
                {CAMPUSES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          )}
        </div>
      )}

      {!isStreaming && onFollowUp && followUpOpts.length > 0 && (
        <div className="tca-followup-panel">
          {followUpOpts.map(opt => (
            <button key={opt} className="tca-followup-chip" onClick={() => onFollowUp(opt)}>
              {opt}
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M2 6h8M8 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ))}
        </div>
      )}

      <SourcesPanel sources={sources} />
    </div>
  )
}

/* ── Page ─────────────────────────────────────────────────────────────── */

export default function Home() {
  const [query, setQuery] = useState('')
  const [exchanges, setExchanges] = useState<Exchange[]>([])
  const [streamingAnswer, setStreamingAnswer] = useState('')
  const [streamingSources, setStreamingSources] = useState<Source[]>([])
  const [streamingStaffCards, setStreamingStaffCards] = useState<StaffCardData[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [trending, setTrending] = useState<string[]>([])
  const userContext = useSyncExternalStore(subscribeContext, getContextSnapshot, getContextServerSnapshot)
  const [showCalendars, setShowCalendars] = useState(false)
  const [showPreferences, setShowPreferences] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const [lastQuery, setLastQuery] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  const hasConversation = exchanges.length > 0 || loading || streamingAnswer !== ''
  const chips = useMemo(() => buildPersonalizedChips(userContext, trending), [userContext, trending])

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/trending', { signal: controller.signal })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d?.chips?.length) setTrending(d.chips) })
      .catch(() => { /* the defaults are already on screen */ })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    let visitorId: string | null = null
    try {
      visitorId = localStorage.getItem('tca_visitor_id')
      if (!visitorId) {
        visitorId = crypto.randomUUID()
        localStorage.setItem('tca_visitor_id', visitorId)
      }
    } catch { /* private mode — the visit is counted without an id */ }

    const payload = JSON.stringify({ path: window.location.pathname, referrer: document.referrer || null, visitorId })
    const blob = new Blob([payload], { type: 'application/json' })
    if (!navigator.sendBeacon('/api/track-visit', blob)) {
      fetch('/api/track-visit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {})
    }
  }, [])

  // "/" focuses the search box the way it does everywhere else on the web.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return
      e.preventDefault()
      inputRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const runSearch = useCallback(async (rawQ: string) => {
    const trimmed = rawQ.trim()
    if (!trimmed || loading) return

    setLastQuery(trimmed)
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    // The sanitizer is fetched here rather than on mount: a visitor who lands
    // and leaves never pays for it, and for everyone else it arrives long
    // before the first token does.
    void preloadSanitizer()

    setLoading(true)
    setError('')
    setStreamingAnswer('')
    setStreamingSources([])
    setStreamingStaffCards([])

    const history = exchanges.flatMap(ex => [
      { role: 'user' as const, content: ex.query },
      { role: 'assistant' as const, content: ex.answer },
    ])

    // Campus and grade are attached only to the opening question — after that
    // the conversation itself carries the context, and repeating the prefix
    // each turn made the model restate it.
    const prefixed = history.length === 0 ? `${buildContextPrefix(userContext)}${trimmed}` : trimmed

    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: prefixed, rawQuery: trimmed, history }),
        signal: controller.signal,
      })

      if (res.status === 429) {
        throw new Error('That was a lot of questions at once — give it a minute and try again.')
      }
      if (!res.ok || !res.body) {
        throw new Error('Search is having a moment. Try again?')
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let finalAnswer = ''
      let finalSources: Source[] = []
      let finalStaffCards: StaffCardData[] = []

      // Tokens arrive far faster than a screen can usefully repaint. They're
      // collected here and flushed on an animation frame, so React renders (and
      // the markdown is parsed) at most once per frame instead of once per
      // token — the same text, a fraction of the work.
      let pending = ''
      let frame: number | null = null
      const flush = () => {
        frame = null
        if (!pending) return
        const chunk = pending
        pending = ''
        setStreamingAnswer(prev => prev + chunk)
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line) as { type: string; sources?: Source[]; text?: string; message?: string; staffCards?: StaffCardData[] }
            if (event.type === 'sources' && event.sources) {
              finalSources = event.sources
              setStreamingSources(event.sources)
            } else if (event.type === 'staffCards' && event.staffCards) {
              finalStaffCards = event.staffCards
              setStreamingStaffCards(event.staffCards)
            } else if (event.type === 'text' && event.text) {
              finalAnswer += event.text
              pending += event.text
              frame ??= requestAnimationFrame(flush)
            } else if (event.type === 'error') {
              // The server sends a sanitized reason; never render a raw API
              // message to a parent regardless of what arrives here.
              setError(event.message === 'assistant unavailable'
                ? 'The assistant is temporarily unavailable — the links below should still help.'
                : 'Something went wrong. Please try again.')
            }
          } catch { /* ignore malformed lines */ }
        }
      }

      if (frame !== null) cancelAnimationFrame(frame)
      flush()

      if (finalAnswer) {
        setExchanges(prev => [...prev, {
          query: trimmed,
          answer: finalAnswer,
          sources: finalSources,
          staffCards: finalStaffCards.length ? finalStaffCards : undefined,
        }])
      }
      setStreamingAnswer('')
      setStreamingSources([])
      setStreamingStaffCards([])
      setQuery('')

      // Answers land at the top of the thread.
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [exchanges, loading, userContext])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    void runSearch(query)
  }

  function handleClarification(lastQuery: string, campus?: string, grade?: string) {
    const parts = [lastQuery]
    if (grade) parts.push(`for a ${grade} student`)
    if (campus) parts.push(`at ${campus}`)
    void runSearch(parts.join(' '))
  }

  function reset() {
    abortRef.current?.abort()
    setExchanges([])
    setStreamingAnswer('')
    setStreamingSources([])
    setStreamingStaffCards([])
    setQuery('')
    setError('')
    setLoading(false)
    inputRef.current?.focus()
  }

  function savePreferences(ctx: TcaUserContext) {
    saveContext(ctx)
    setShowPreferences(false)
  }

  const personalized = Boolean(userContext && (userContext.campuses.length || userContext.grades.length))

  return (
    <div className="tca-page">
      <div className="tca-bg-glow" />

      <main className="tca-main" data-conversation={hasConversation}>
        <div className="tca-hero tca-column">
          <div>
            <h1 className="tca-wordmark">tca<b>hub</b></h1>
            {!hasConversation && (
              <>
                <p className="tca-tagline" style={{ marginTop: 6 }}>
                  Ask about <CyclingText />
                </p>
                <p className="tca-byline" style={{ marginTop: 8 }}>
                  Built with love by a TCA family ·{' '}
                  <a
                    href="https://ai-delivered.com/local"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--crimson)', textDecoration: 'none' }}
                  >
                    ai-delivered
                  </a>
                </p>
              </>
            )}
          </div>

          <form onSubmit={handleSubmit} className="tca-search-wrap">
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onFocus={() => void preloadSanitizer()}
              placeholder={hasConversation ? 'Ask a follow-up…' : 'Ask anything about TCA…'}
              className="tca-search-input"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="sentences"
              spellCheck={false}
              enterKeyHint="search"
              maxLength={500}
              aria-label="Ask a question about TCA"
            />
            <button type="submit" disabled={loading || !query.trim()} className="tca-search-btn" aria-label="Search">
              {loading && !streamingAnswer
                ? <span className="tca-dots" aria-hidden="true"><span /><span /><span /></span>
                : <SearchIcon />}
            </button>
          </form>

          {!hasConversation && (
            <>
              {/* These were computed and then never rendered — the trending
                  request was made on every page load and the result thrown
                  away. They are the fastest route to an answer on a phone. */}
              <div className="tca-chip-row" aria-label="Suggested questions">
                {chips.map(chip => (
                  <button key={chip} className="tca-chip" onClick={() => void runSearch(chip)} disabled={loading}>
                    {chip}
                  </button>
                ))}
              </div>

              <div className="tca-chip-row">
                <button className="tca-chip" data-variant="quiet" onClick={() => setShowCalendars(true)}>
                  Calendars &amp; Schedules
                </button>
                <a
                  className="tca-chip"
                  data-variant="quiet"
                  href="https://www.tcatitans.org/family/staff-directory"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Staff Directory
                </a>
                <button className="tca-chip" data-variant="quiet" onClick={() => setShowPreferences(true)}>
                  {personalized ? 'Edit my student' : 'Personalize'}
                </button>
              </div>

              <p className="tca-hint">
                Press <kbd>/</kbd> to search
              </p>
            </>
          )}
        </div>

        {error && (
          <div className="tca-error tca-column" role="alert">
            <span>{error}</span>
            {lastQuery && (
              <button className="tca-retry" onClick={() => void runSearch(lastQuery)}>
                Try again
              </button>
            )}
          </div>
        )}

        {hasConversation && (
          <div className="tca-column" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <button className="tca-link-btn" onClick={reset}>← New search</button>

            {(loading || streamingAnswer) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {streamingStaffCards.length > 0 && <StaffCards cards={streamingStaffCards} />}
                <AnswerCard answer={streamingAnswer} sources={streamingSources} isStreaming />
              </div>
            )}

            {[...exchanges].reverse().map((ex, i) => {
              const isNewest = i === 0 && !loading && streamingAnswer === ''
              const showLabel = exchanges.length > 1 || loading || streamingAnswer !== ''
              return (
                <div key={exchanges.length - 1 - i} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {showLabel && <p className="tca-quoted">&ldquo;{ex.query}&rdquo;</p>}
                  {ex.staffCards && <StaffCards cards={ex.staffCards} />}
                  <AnswerCard
                    answer={ex.answer}
                    sources={ex.sources}
                    onClarify={isNewest ? (campus, grade) => handleClarification(ex.query, campus, grade) : undefined}
                    onFollowUp={isNewest ? opt => void runSearch(`${ex.query} at ${opt}`) : undefined}
                  />
                </div>
              )
            })}
          </div>
        )}
      </main>

      {showCalendars && <CalendarPanel onClose={() => setShowCalendars(false)} />}
      {showPreferences && (
        <PreferencesPanel
          initial={userContext}
          onSave={savePreferences}
          onClose={() => setShowPreferences(false)}
        />
      )}
      <AddToHomePrompt />

      <footer className="tca-footer">
        <p>The Classical Academy · Colorado Springs, Colorado</p>
      </footer>
    </div>
  )
}
