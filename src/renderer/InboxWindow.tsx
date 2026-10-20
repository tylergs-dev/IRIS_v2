import { useEffect } from 'react'
import { EmailInbox } from './components/EmailInbox'
import { connectInboxBridge } from './store/bridge'
import { useStore } from './store'

/**
 * Root of the inbox popout. Nothing but the inbox: no sidebar, no composer, no audio graph —
 * the main window owns the microphone and speaker, and this window must never compete for them.
 * Main opens it when email mode starts and closes it when the mode ends, so the "not running"
 * state below is only ever seen for a moment.
 */
export function InboxWindow(): React.JSX.Element {
  const email = useStore((state) => state.email)
  const voiceState = useStore((state) => state.voiceState)

  useEffect(() => connectInboxBridge(), [])

  // Escape here mirrors Escape in the main window: cut speech, stay in the mode.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') void window.iris.invoke('voice:stop')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const active = email !== null && email.phase !== 'idle'

  return (
    <div className="inbox-window">
      <div className="ambience" data-state={voiceState} aria-hidden="true" />
      <main className="main">
        {active ? (
          <EmailInbox />
        ) : (
          <p className="inbox-empty" role="status">
            Email mode is not running.
          </p>
        )}
      </main>
    </div>
  )
}
