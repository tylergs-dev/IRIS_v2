import { LiveRegion } from '../a11y/LiveRegion'
import { dismissNotice, useStore } from '../store'

export function Notices(): React.JSX.Element {
  const notices = useStore((state) => state.notices)

  // Only what IRIS could not say itself. When voice is working it has already said these, and
  // announcing them again would put the screen reader on top of IRIS mid-sentence.
  const undelivered = notices
    .filter((notice) => !notice.spoken)
    .map((notice) => notice.text)
    .join('. ')

  return (
    <>
      {/*
        Mounted from startup and left mounted, even with nothing to say. A live region that appears
        in the DOM with text already inside it is frequently not announced at all — the change has
        to happen to a region the screen reader is already watching. Since this is the path for
        messages IRIS could not speak, failing to announce would mean losing them entirely.
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
