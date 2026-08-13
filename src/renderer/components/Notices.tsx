import { LiveRegion } from '../a11y/LiveRegion'
import { dismissNotice, useStore } from '../store'

export function Notices(): React.JSX.Element {
  const notices = useStore((state) => state.notices)

  // Only what IRIS could not say itself. Shown on screen for a helper; a live region is kept for
  // anyone using a screen reader on this window, but the daily user is not expected to have one.
  const undelivered = notices
    .filter((notice) => !notice.spoken)
    .map((notice) => notice.text)
    .join('. ')

  return (
    <>
      {/*
        Mounted from startup and left mounted. Harmless if nobody is running a screen reader;
        useful if a helper is. Spoken notices are filtered out above so IRIS and a screen reader
        never talk over each other.
      */}
      <LiveRegion text={undelivered} assertive />

      {notices.length > 0 ? (
        <div className="notices">
          {notices.map((notice) => (
            <div key={notice.id} className={`notice notice-${notice.severity}`}>
              <p>{notice.text}</p>
              <button onClick={() => dismissNotice(notice.id)} aria-label="Dismiss message">
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </>
  )
}
