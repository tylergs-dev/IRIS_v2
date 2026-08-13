import { useEffect, useRef } from 'react'
import type { ConnectionState } from '@shared/types'
import { LiveRegion, useAnnouncement } from './a11y/LiveRegion'
import { audio } from './audio'
import { ChatLog } from './components/ChatLog'
import { Notices } from './components/Notices'
import { Settings } from './components/Settings'
import { Skills } from './components/Skills'
import { StatusOrb, stateLabel } from './components/StatusOrb'
import { TaskPanel } from './components/TaskPanel'
import { VoiceControls } from './components/VoiceControls'
import { connectBridge } from './store/bridge'
import { setTab, useStore, type Tab } from './store'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'chat', label: 'Conversation' },
  { id: 'skills', label: 'Skills' },
  { id: 'settings', label: 'Settings' }
]

function HealthRow({ label, state }: { label: string; state: ConnectionState }): React.JSX.Element {
  return (
    <div className="health-row">
      <span className={`dot ${state}`} aria-hidden="true" />
      <span>
        {label}: {state}
      </span>
    </div>
  )
}

export function App(): React.JSX.Element {
  const tab = useStore((state) => state.tab)
  const voiceState = useStore((state) => state.voiceState)
  const health = useStore((state) => state.health)
  const cost = useStore((state) => state.cost)
  const profile = useStore((state) => state.profile)
  const keys = useStore((state) => state.keys)
  const startedSetup = useRef(false)
  const settledState = useAnnouncement(stateLabel(voiceState))

  useEffect(() => connectBridge(), [])

  // Started once at launch and left open. A blind user cannot click to grant the microphone, so
  // the graph must be ready before the first wake, and re-opening it costs 200-500 ms each time.
  useEffect(() => {
    void audio.start()
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') void window.iris.invoke('voice:stop')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // First run introduces itself out loud without being asked: the user has no way to discover a
  // "start setup" button. It waits for the API key, since with no key there is no voice to do it
  // with, and runs once per launch even if setup is only part-finished.
  const needsSetup = profile !== null && !profile.onboarded
  const canSpeak = keys.geminiApiKey
  useEffect(() => {
    if (!needsSetup || !canSpeak || startedSetup.current) return
    startedSetup.current = true
    void window.iris.invoke('onboarding:start')
  }, [needsSetup, canSpeak])

  return (
    <div className="app">
      {/* Decorative twin of the orb, for anyone who can see the window but is not looking at it. */}
      <div className="ambience" data-state={voiceState} aria-hidden="true" />

      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <StatusOrb state={voiceState} />
          <h1>IRIS</h1>
        </div>

        <div className="nav">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setTab(entry.id)}
              aria-current={tab === entry.id ? 'page' : undefined}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="sidebar-foot">
          <div className="health" aria-label="Service status">
            <HealthRow label="Voice" state={health.voice} />
            <HealthRow label="Gmail" state={health.gmail} />
            <HealthRow label="Search" state={health.search} />
            <HealthRow label="Browser" state={health.browser} />
            <HealthRow label="Wake word" state={health.wakeWord} />
          </div>
          {cost && cost.sessionSeconds > 0 ? (
            <span>
              Session: {Math.round(cost.sessionSeconds / 60)} min · ~$
              {cost.estimatedUsd.toFixed(3)}
            </span>
          ) : null}
        </div>
      </nav>

      <main className="main">
        <Notices />

        {/*
          Voice state, for anyone using a screen reader on the helper window. Debounced, because
          waking runs through three states inside a second and only where it settles is worth
          hearing. The daily user hears IRIS, not this.
        */}
        <LiveRegion text={settledState ? `IRIS is ${settledState.toLowerCase()}` : ''} />

        {/*
          The one thing that cannot be explained by voice, because voice is what it unblocks.
          Whoever helps with the initial setup needs to see it, so it is loud and on screen.
        */}
        {profile && !canSpeak && tab !== 'settings' ? (
          <div className="panel first-run" role="alert">
            <h2>One thing before IRIS can talk</h2>
            <p>
              IRIS needs a Google Gemini API key. Until it has one it cannot speak or listen, so
              this is the only step that has to be done on screen — everything after it is spoken
              aloud.
            </p>
            <button className="btn btn-primary" onClick={() => setTab('settings')}>
              Open Settings to add the key
            </button>
          </div>
        ) : null}

        {tab === 'chat' ? (
          <>
            <div className="panel panel-chat">
              <ChatLog />
            </div>
            <VoiceControls />
          </>
        ) : null}
        {tab === 'skills' ? <Skills /> : null}
        {tab === 'settings' ? <Settings /> : null}

        <TaskPanel />
      </main>
    </div>
  )
}
