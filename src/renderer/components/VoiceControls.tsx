import { useState } from 'react'
import { useStore } from '../store'
import { stateLabel } from './StatusOrb'

export function VoiceControls(): React.JSX.Element {
  const voiceState = useStore((state) => state.voiceState)
  const micError = useStore((state) => state.micError)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const asleep = voiceState === 'asleep'

  async function send(): Promise<void> {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    setDraft('')
    try {
      await window.iris.invoke('voice:sendText', text)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="composer">
      <div className="composer-row">
        <label className="sr-only" htmlFor="composer-input">
          Type a message to IRIS
        </label>
        <textarea
          id="composer-input"
          value={draft}
          placeholder="Type to IRIS — replies are always spoken aloud"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <button className="btn btn-primary" onClick={() => void send()} disabled={!draft.trim()}>
          Send
        </button>
      </div>

      <div className="controls">
        <button
          className="btn btn-danger"
          onClick={() => void window.iris.invoke('voice:stop')}
          aria-keyshortcuts="Escape"
        >
          Stop
        </button>
        <button
          className="btn"
          onClick={() => void window.iris.invoke('voice:wake')}
          disabled={!asleep}
        >
          Wake
        </button>
        <button
          className="btn"
          onClick={() => void window.iris.invoke('voice:sleep')}
          disabled={asleep}
        >
          Sleep
        </button>
        <span className="spacer" />
        <span className="state-label" aria-hidden="true">
          {stateLabel(voiceState)}
        </span>
      </div>

      {micError ? (
        <p className="hint" style={{ color: 'var(--danger)', marginTop: 8 }}>
          {micError}
        </p>
      ) : (
        <p className="hint" style={{ marginTop: 8 }}>
          Every control here has a spoken equivalent: say “stop”, “go to sleep”, or “wake up”.
        </p>
      )}
    </div>
  )
}
