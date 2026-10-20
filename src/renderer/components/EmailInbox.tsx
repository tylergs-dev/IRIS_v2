import { useEffect, useRef, useState } from 'react'
import type { EmailDisposition, EmailHeader, EmailModePhase, EmailUiAction } from '@shared/types'
import { useStore } from '../store'

/** Gmail-style column date: time for today, weekday this week, otherwise month and day. */
function shortDate(raw: string, now = new Date()): string {
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return ''
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
  const days = (now.getTime() - date.getTime()) / 86_400_000
  if (days < 6) return date.toLocaleDateString('en-US', { weekday: 'short' })
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function phaseLabel(phase: EmailModePhase, offline: boolean): string {
  switch (phase) {
    case 'fetchingQueue':
      return 'Fetching inbox'
    case 'readingHeader':
      return 'Reading header'
    case 'awaitingHeaderChoice':
      return offline ? 'Offline — reading from cache' : 'Waiting for your choice'
    case 'summarizing':
      return 'Summarizing'
    case 'awaitingPostSummaryChoice':
      return 'Summary read'
    case 'articleReview':
      return 'Reviewing articles'
    case 'exhausted':
      return 'Inbox clear'
    default:
      return ''
  }
}

const DISPOSITION_LABEL: Record<EmailDisposition, string> = {
  skipped: 'Skipped',
  read: 'Read',
  deleted: 'Deleted',
  moved: 'Moved'
}

function Row({
  header,
  index,
  current,
  disposition
}: {
  header: EmailHeader
  index: number
  current: boolean
  disposition: EmailDisposition | undefined
}): React.JSX.Element {
  const ref = useRef<HTMLLIElement>(null)

  useEffect(() => {
    if (current) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [current])

  const className = [
    'inbox-row',
    current ? 'inbox-row--current' : '',
    disposition ? `inbox-row--done inbox-row--${disposition}` : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <li ref={ref} className={className} aria-current={current ? 'true' : undefined}>
      <span className="inbox-index" aria-hidden="true">
        {index + 1}
      </span>
      <span className="inbox-from" title={header.fromAddress}>
        {header.fromName || header.fromAddress}
      </span>
      <span className="inbox-subject">
        <span className="inbox-subject-text">{header.subject || '(no subject)'}</span>
        {header.snippet ? <span className="inbox-snippet"> — {header.snippet}</span> : null}
      </span>
      <span className="inbox-meta">
        {disposition ? (
          <span className={`inbox-tag inbox-tag--${disposition}`}>
            {DISPOSITION_LABEL[disposition]}
          </span>
        ) : null}
        <time dateTime={header.date}>{shortDate(header.date)}</time>
      </span>
    </li>
  )
}

/**
 * A pseudo inbox for email mode. IRIS narrates everything here already, so the list is for a
 * sighted helper, and the buttons are a fallback when speech is not landing: they run exactly
 * the same actions the voice tool would, through the same machine and narration.
 */
export function EmailInbox(): React.JSX.Element | null {
  const email = useStore((state) => state.email)
  const account = useStore((state) => state.account)
  // A press is "pending" only until the next snapshot arrives: main emits one as soon as it
  // accepts or refuses the action, and every emit is a fresh object. Remembering which snapshot
  // the press was made against keeps a refused press from sticking without an effect.
  const [press, setPress] = useState<{ action: EmailUiAction; against: unknown } | null>(null)
  const pending = press && press.against === email ? press.action : null

  if (!email || email.phase === 'idle') return null

  const { phase, queue, queueLength, current, position, dispositions, offline, busy } = email
  // queueLength is the inbox total from the id list; the queue itself fills in chunk by chunk.
  const handled = queue.filter((header) => dispositions[header.id]).length
  const remaining = Math.max(0, queueLength - handled)
  const stillLoading = queueLength - queue.length
  const fetching = phase === 'fetchingQueue'
  const exhausted = phase === 'exhausted'

  // Actions the machine would refuse are disabled rather than letting a click produce a spoken
  // "still working" every time, which would drown out the narration it is waiting on.
  const settled = !busy && pending === null && current !== null
  const canReadMore =
    settled && !offline && (phase === 'readingHeader' || phase === 'awaitingHeaderChoice')
  const canSkip = settled
  const canDelete = settled && !offline

  async function act(action: EmailUiAction): Promise<void> {
    setPress({ action, against: email })
    try {
      await window.iris.invoke('email:action', action)
    } catch {
      setPress(null)
    }
  }

  return (
    <section className="panel inbox" aria-label="Email mode inbox">
      <header className="inbox-head">
        <div className="inbox-title">
          <h2>Primary inbox</h2>
          <span className="hint">
            {account ? account.email : 'Gmail'}
            {queueLength > 0 ? ` · ${remaining} of ${queueLength} unread left` : ''}
          </span>
        </div>
        <div className="inbox-status">
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          <span className={`badge ${offline ? 'badge-off' : 'badge-on'}`}>
            {phaseLabel(phase, offline)}
          </span>
          <button
            className="btn"
            onClick={() => void act('stop')}
            disabled={pending !== null}
            aria-label="Leave email mode"
          >
            Leave
          </button>
        </div>
      </header>

      {fetching && queue.length === 0 ? (
        <p className="inbox-empty" role="status">
          Fetching unread mail from the Primary tab…
        </p>
      ) : null}

      {!fetching && queue.length === 0 ? (
        <p className="inbox-empty" role="status">
          There is no unread mail in the inbox.
        </p>
      ) : null}

      {queue.length > 0 ? (
        <ol className="inbox-list" aria-label="Unread messages">
          {queue.map((header, index) => (
            <Row
              key={header.id}
              header={header}
              index={index}
              current={position !== null && index === position - 1}
              disposition={dispositions[header.id]}
            />
          ))}
          {stillLoading > 0 ? (
            <li className="inbox-loading" role="status">
              <span className="spinner" aria-hidden="true" />
              Loading {stillLoading} more…
            </li>
          ) : null}
        </ol>
      ) : null}

      {exhausted && queue.length > 0 ? (
        <p className="inbox-empty" role="status">
          That was the last unread email.
        </p>
      ) : null}

      <footer className="inbox-actions">
        <div className="inbox-current" aria-live="off">
          {current ? (
            <>
              <strong>{current.fromName || current.fromAddress}</strong>
              <span className="hint">{current.subject || '(no subject)'}</span>
            </>
          ) : (
            <span className="hint">{exhausted ? 'Nothing left to act on.' : ' '}</span>
          )}
        </div>
        <div className="inbox-buttons">
          <button
            className="btn btn-primary"
            onClick={() => void act('readMore')}
            disabled={!canReadMore}
            title={offline ? 'Needs Gmail, which is unreachable right now' : undefined}
          >
            {pending === 'readMore' ? 'Opening…' : 'Read more'}
          </button>
          <button className="btn" onClick={() => void act('next')} disabled={!canSkip}>
            {pending === 'next' ? 'Skipping…' : 'Skip'}
          </button>
          <button
            className="btn btn-danger"
            onClick={() => void act('delete')}
            disabled={!canDelete}
            title={offline ? 'Needs Gmail, which is unreachable right now' : undefined}
          >
            {pending === 'delete' ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </footer>
    </section>
  )
}
