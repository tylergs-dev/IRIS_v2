import { useEffect, useState } from 'react'
import { useStore } from '../store'

export function Skills(): React.JSX.Element {
  const keys = useStore((state) => state.keys)
  const account = useStore((state) => state.account)
  const readingList = useStore((state) => state.readingList)
  const browserOk = useStore((state) => state.health.browser) === 'online'
  const wakeOk = useStore((state) => state.health.wakeWord) === 'online'
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.iris
      .invoke('auth:googleStatus')
      .then((value) => useStore.setState({ account: value }))
      .catch(() => undefined)
    window.iris
      .invoke('reading:list')
      .then((value) => useStore.setState({ readingList: value }))
      .catch(() => undefined)
  }, [])

  async function connectGoogle(): Promise<void> {
    setConnecting(true)
    setError(null)
    try {
      const result = await window.iris.invoke('auth:googleConnect')
      useStore.setState({ account: result })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setConnecting(false)
    }
  }

  return (
    <div className="panel">
      <h2>Skills</h2>
      <p className="lede">
        What IRIS can do, and what still needs connecting. Anything not connected here will be
        explained out loud if you ask IRIS to use it.
      </p>

      <div className="cards">
        <section className="card">
          <div className="card-head">
            <h3>Email — Gmail</h3>
            <span className={`badge ${account ? 'badge-on' : 'badge-off'}`}>
              {account ? 'Connected' : 'Not connected'}
            </span>
          </div>
          <p>
            Reads your primary inbox one email at a time — sender and subject first, then a
            summary if you ask. Spam and Promotions are never touched. “Delete” moves an email to
            Trash, so it can always be recovered.
          </p>
          {account ? (
            <div className="row">
              <span className="hint">Signed in as {account.email}</span>
              <button
                className="btn btn-danger"
                onClick={() => {
                  void window.iris.invoke('auth:googleDisconnect')
                  useStore.setState({ account: null })
                }}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button className="btn btn-primary" onClick={() => void connectGoogle()} disabled={connecting}>
              {connecting ? 'Waiting for your browser…' : 'Connect Gmail'}
            </button>
          )}
          {error ? (
            <p className="hint" style={{ color: 'var(--danger)', marginTop: 10 }}>
              {error}
            </p>
          ) : null}
          <p className="hint" style={{ marginTop: 10 }}>
            Sign-in opens in your own web browser so your screen reader and password manager
            work normally. Google will show a “hasn’t verified this app” notice once — choose
            Advanced, then continue.
          </p>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Quick web search</h3>
            <span className={`badge ${keys.tavilyApiKey ? 'badge-on' : 'badge-off'}`}>
              {keys.tavilyApiKey ? 'Ready' : 'Needs key'}
            </span>
          </div>
          <p>Short, cited answers to factual questions. Add a Tavily key in Settings.</p>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Web browsing</h3>
            <span className={`badge ${browserOk ? 'badge-on' : 'badge-off'}`}>
              {browserOk ? 'Ready' : 'Needs Edge or Chrome'}
            </span>
          </div>
          <p>
            For anything a single search can’t answer, IRIS drives a real browser and narrates
            every page it visits and every button it presses before pressing it.
          </p>
          {browserOk ? null : (
            <p className="hint">
              IRIS uses Microsoft Edge or Google Chrome, whichever it finds. Edge is installed
              with Windows, so this is usually already fine — it just isn’t confirmed until the
              first time IRIS browses.
            </p>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h3>“Hey IRIS” wake word</h3>
            <span className={`badge ${wakeOk ? 'badge-on' : 'badge-off'}`}>
              {wakeOk ? 'Listening' : 'Not installed'}
            </span>
          </div>
          <p>
            {wakeOk
              ? 'Say “hey IRIS” when IRIS is asleep and it will start listening. Control Shift I ' +
                'always does the same thing.'
              : 'The wake word needs a voice model that isn’t installed. Control Shift I wakes ' +
                'IRIS from anywhere, including when another window is in front, and the Wake ' +
                'button does the same.'}
          </p>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Reading list</h3>
            <span className="badge badge-off">{readingList.length} saved</span>
          </div>
          <p>Articles you saved during Email Mode. Ask “read me my saved articles” any time.</p>
          {readingList.length === 0 ? (
            <p className="empty">Nothing saved yet.</p>
          ) : (
            <ul className="list">
              {readingList.map((article) => (
                <li key={article.id}>
                  <span>
                    <a
                      href={article.href}
                      onClick={(event) => {
                        event.preventDefault()
                        void window.iris.invoke('shell:openExternal', article.href)
                      }}
                    >
                      {article.title}
                    </a>
                    <br />
                    <span className="hint">{article.sourceSender}</span>
                  </span>
                  <button
                    className="btn"
                    onClick={() => void window.iris.invoke('reading:remove', article.id)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
