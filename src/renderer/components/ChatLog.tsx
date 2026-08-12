import { useEffect, useRef } from 'react'
import type { ChatMessage } from '@shared/types'
import { useStore } from '../store'

const ROLE_LABEL: Record<ChatMessage['role'], string> = {
  user: 'You',
  iris: 'IRIS',
  system: 'System'
}

export function ChatLog(): React.JSX.Element {
  const messages = useStore((state) => state.messages)
  const logRef = useRef<HTMLDivElement>(null)
  const lastText = messages[messages.length - 1]?.text

  // Scrolls the log itself rather than the element into view, so a long conversation can never push
  // the composer off screen. Transcripts stream in token by token, so this also runs on every text
  // change — but only follows the tail when the reader is already there, otherwise someone scrolled
  // back through history would be yanked forward mid-sentence.
  useEffect(() => {
    const log = logRef.current
    if (!log) return
    const distanceFromBottom = log.scrollHeight - log.scrollTop - log.clientHeight
    if (distanceFromBottom < 80) log.scrollTop = log.scrollHeight
  }, [messages.length, lastText])

  return (
    // Deliberately not a live region. Every line here has already been spoken by IRIS in its own
    // voice, so announcing it again means two voices at once — and because transcripts stream in
    // token by token, a live region would re-announce the same sentence as it grew. It stays a log
    // so a screen reader user can navigate back through the conversation on purpose.
    <div className="chat" role="log" aria-label="Conversation" tabIndex={0} ref={logRef}>
      {messages.length === 0 ? (
        <div className="chat-empty">
          <p>
            Say <strong>“IRIS”</strong> or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd> to
            start talking. You can also type below — I’ll still answer out loud.
          </p>
          <p className="hint">Try “do my emails” to start Email Mode.</p>
        </div>
      ) : (
        messages.map((message) => (
          <div key={message.id} className={`msg msg-${message.role}`}>
            <span className="msg-role">{ROLE_LABEL[message.role]}</span>
            {message.text}
            {message.streaming ? <i className="caret" aria-hidden="true" /> : null}
          </div>
        ))
      )}
    </div>
  )
}
