import { useState } from 'react'
import type { SecretName, SpeechPace, SummaryLength, UserProfile } from '@shared/types'
import { DEFAULT_VOICE, LIVE_VOICES, type VoiceName } from '@shared/voices'
import { useStore } from '../store'

function ArticleReviewSenders({
  profile,
  patch
}: {
  profile: UserProfile | null
  patch: (update: Partial<UserProfile>) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const senders = profile?.digestSenders ?? []

  function add(): void {
    const value = draft.trim()
    if (!value) return
    if (senders.some((entry) => entry.toLowerCase() === value.toLowerCase())) {
      setDraft('')
      return
    }
    patch({ digestSenders: [...senders, value] })
    setDraft('')
  }

  return (
    <section className="card">
      <h3>Article review senders</h3>
      <p>
        IRIS only walks article links one by one for these senders. Everyone else is summarized
        like a normal email. A name, a domain, or a full address all work.
      </p>
      {senders.length === 0 ? (
        <p className="empty">None yet — add a publication below, or turn on extra detection.</p>
      ) : (
        <ul className="list">
          {senders.map((sender) => (
            <li key={sender}>
              <span>{sender}</span>
              <button
                className="btn"
                onClick={() =>
                  patch({ digestSenders: senders.filter((entry) => entry !== sender) })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="field" style={{ marginTop: 14 }}>
        <label htmlFor="digest-sender">Add a sender</label>
        <div className="row">
          <input
            id="digest-sender"
            value={draft}
            placeholder="Morningstar, kiplinger.com, or news@example.com"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') add()
            }}
            style={{ flex: 1, minWidth: 240 }}
          />
          <button className="btn" onClick={add} disabled={!draft.trim()}>
            Add
          </button>
        </div>
      </div>
      <div className="field">
        <label htmlFor="auto-digest">Other newsletters</label>
        <div className="row">
          <input
            id="auto-digest"
            type="checkbox"
            checked={profile?.autoDetectDigests ?? false}
            onChange={(event) => patch({ autoDetectDigests: event.target.checked })}
          />
          <span className="hint">
            Also try to notice unlisted newsletters and offer to review their articles.
          </span>
        </div>
      </div>
    </section>
  )
}

function KeyField({
  name,
  label,
  help,
  present
}: {
  name: SecretName
  label: string
  help: string
  present: boolean
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  async function save(): Promise<void> {
    if (!value.trim()) return
    setSaving(true)
    try {
      await window.iris.invoke('keys:set', name, value)
      setValue('')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="field">
      <label htmlFor={`key-${name}`}>{label}</label>
      <div className="row">
        <input
          id={`key-${name}`}
          type="password"
          autoComplete="off"
          value={value}
          placeholder={present ? 'Saved — enter a new key to replace it' : 'Not set'}
          onChange={(event) => setValue(event.target.value)}
          style={{ flex: 1, minWidth: 240 }}
        />
        <button className="btn" onClick={() => void save()} disabled={!value.trim() || saving}>
          Save
        </button>
        {present ? (
          <button
            className="btn btn-danger"
            onClick={() => void window.iris.invoke('keys:clear', name)}
          >
            Remove
          </button>
        ) : null}
        <span className={`badge ${present ? 'badge-on' : 'badge-off'}`}>
          {present ? 'Set' : 'Missing'}
        </span>
      </div>
      <span className="hint">{help}</span>
    </div>
  )
}

export function Settings(): React.JSX.Element {
  const profile = useStore((state) => state.profile)
  const keys = useStore((state) => state.keys)

  function patch(update: Partial<UserProfile>): void {
    void window.iris.invoke('profile:set', update)
  }

  return (
    <div className="panel">
      <h2>Settings</h2>
      <p className="lede">
        Keys are encrypted with your operating system’s secure storage and never leave this
        machine. Everything here can also be changed by asking IRIS out loud.
      </p>

      <div className="cards">
        <section className="card">
          <h3>API keys</h3>
          <p>IRIS needs a Gemini key to talk, and a Tavily key for quick web answers.</p>
          <KeyField
            name="geminiApiKey"
            label="Gemini API key"
            help="Restrict the key to generativelanguage.googleapis.com — unrestricted keys are rejected."
            present={keys.geminiApiKey}
          />
          <KeyField
            name="tavilyApiKey"
            label="Tavily API key"
            help="Used for fast, cited web search answers."
            present={keys.tavilyApiKey}
          />
        </section>

        <section className="card">
          <h3>Google sign-in details</h3>
          <p>
            Gmail needs an OAuth client from your own Google Cloud project. Create a{' '}
            <strong>Desktop app</strong> client, grant only the <code>gmail.modify</code> scope,
            and set the app’s publishing status to <strong>In production</strong> — in “Testing”
            mode Google expires the sign-in every seven days.
          </p>
          <KeyField
            name="googleClientId"
            label="OAuth client ID"
            help="Ends in .apps.googleusercontent.com"
            present={keys.googleClientId}
          />
          <KeyField
            name="googleClientSecret"
            label="OAuth client secret"
            help="Required at the token endpoint even though Google's docs call it optional."
            present={keys.googleClientSecret}
          />
        </section>

        <section className="card">
          <h3>About you</h3>
          <p>Used for weather, local questions, and how IRIS addresses you.</p>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="preferred-name">Preferred name</label>
              <input
                id="preferred-name"
                value={profile?.preferredName ?? ''}
                onChange={(event) => patch({ preferredName: event.target.value || null })}
              />
            </div>
            <div className="field">
              <label htmlFor="city">City</label>
              <input
                id="city"
                value={profile?.city ?? ''}
                onChange={(event) => patch({ city: event.target.value || null })}
              />
            </div>
            <div className="field">
              <label htmlFor="region">State or region</label>
              <input
                id="region"
                value={profile?.region ?? ''}
                onChange={(event) => patch({ region: event.target.value || null })}
              />
            </div>
            <div className="field">
              <label htmlFor="timezone">Time zone</label>
              <input
                id="timezone"
                value={profile?.timezone ?? ''}
                placeholder="Detected automatically"
                onChange={(event) => patch({ timezone: event.target.value || null })}
              />
            </div>
          </div>
        </section>

        <section className="card">
          <h3>Voice and pacing</h3>
          <div className="field">
            <label htmlFor="voice">Speaking voice</label>
            <select
              id="voice"
              value={profile?.voiceName ?? DEFAULT_VOICE}
              onChange={(event) => patch({ voiceName: event.target.value as VoiceName })}
            >
              {LIVE_VOICES.map((voice) => (
                <option key={voice.name} value={voice.name}>
                  {voice.name} — {voice.description}
                </option>
              ))}
            </select>
            <span className="hint">
              IRIS says a short line in the new voice as soon as you pick one, so you can hear it
              before deciding. Changing it starts a fresh conversation.
            </span>
          </div>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="pace">Speaking pace</label>
              <select
                id="pace"
                value={profile?.speechPace ?? 'normal'}
                onChange={(event) => patch({ speechPace: event.target.value as SpeechPace })}
              >
                <option value="slow">Slower and unhurried</option>
                <option value="normal">Normal</option>
                <option value="fast">Fast</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="summary-length">Email and article summaries</label>
              <select
                id="summary-length"
                value={profile?.summaryLength ?? 'short'}
                onChange={(event) =>
                  patch({ summaryLength: event.target.value as SummaryLength })
                }
              >
                <option value="short">Short by default</option>
                <option value="detailed">More detail by default</option>
              </select>
            </div>
          </div>
        </section>

        <ArticleReviewSenders profile={profile} patch={patch} />

        <section className="card">
          <h3>Spoken setup</h3>
          <p>
            IRIS asks a handful of questions out loud the first time it runs. You can hear them
            again at any point — your existing answers stay until you change them.
          </p>
          <div className="row">
            <button
              className="btn"
              onClick={() => {
                patch({ onboarded: false, onboardingDone: [] })
                void window.iris.invoke('onboarding:start')
              }}
            >
              Run spoken setup again
            </button>
            <span className="hint">
              {profile?.onboarded ? 'Setup is complete.' : 'Setup has not been finished yet.'}
            </span>
          </div>
        </section>

        {profile && profile.interests.length + (profile.notes ? 1 : 0) > 0 ? (
          <section className="card">
            <h3>What IRIS remembers</h3>
            <p>
              Things you have mentioned in conversation. IRIS uses these for context; clearing
              them is harmless.
            </p>
            {profile.interests.length > 0 ? (
              <p>
                <strong>Interests:</strong> {profile.interests.join(', ')}
              </p>
            ) : null}
            {profile.notes ? (
              <p>
                <strong>Notes:</strong> {profile.notes}
              </p>
            ) : null}
            <button
              className="btn btn-danger"
              onClick={() => patch({ interests: [], notes: null })}
            >
              Forget all of this
            </button>
          </section>
        ) : null}
      </div>
    </div>
  )
}
