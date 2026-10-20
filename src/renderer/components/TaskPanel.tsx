import { useStore } from '../store'

/**
 * Visual mirror of a running skill. It is deliberately not the primary channel — the same steps are
 * narrated aloud by the skill itself, so this panel is for a sighted helper. For the same reason it
 * is not a live region: the steps would arrive in a screen reader's ear at the same time as IRIS
 * describing them. Labelled so it can still be found and read on purpose.
 *
 * Email mode has its own view (EmailInbox) that covers fetching and summarizing, so it is not
 * mirrored here as well.
 */
export function TaskPanel(): React.JSX.Element | null {
  const task = useStore((state) => state.task)
  if (!task) return null

  const title = task.title
  const state = task.state
  const progress = task.progress
  const recent = task.steps.slice(-6)
  const indeterminate = state === 'running' && progress === undefined
  const showSpinner = state === 'running'

  return (
    <aside className="task-panel" aria-label={`Task in progress: ${title}`}>
      <div className="task-head">
        {showSpinner ? <span className="spinner" aria-hidden="true" /> : null}
        <span>{title}</span>
      </div>
      <div className={`task-bar${indeterminate ? ' task-bar--indeterminate' : ''}`}>
        <i style={indeterminate ? undefined : { width: `${Math.round((progress ?? 0) * 100)}%` }} />
      </div>
      <ul className="task-steps">
        {recent.map((step, index) => (
          <li key={`${index}-${step}`}>{step}</li>
        ))}
        {recent.length === 0 ? <li>Starting…</li> : null}
      </ul>
    </aside>
  )
}
