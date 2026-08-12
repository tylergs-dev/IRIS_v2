import { useEffect, useRef, useState } from 'react'

/**
 * Screen reader announcements, debounced.
 *
 * The governing constraint here is that IRIS already speaks. A screen reader reading the same text
 * at the same time is not redundancy, it is two voices talking over each other, and the user cannot
 * turn either one down. So the live regions carry only what IRIS does *not* say: state changes,
 * and messages that could not be delivered by voice.
 *
 * Debouncing matters for the same reason. States can change three times in a second — listening,
 * thinking, speaking — and an undebounced region queues an announcement for each, so the user is
 * still hearing about "thinking" while IRIS is halfway through its answer. Only the settled value
 * is worth saying.
 */
const SETTLE_MS = 700

export function useAnnouncement(value: string, settleMs = SETTLE_MS): string {
  const [announced, setAnnounced] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setAnnounced(value), settleMs)
    return () => clearTimeout(timer.current)
  }, [value, settleMs])

  return announced
}

/**
 * `polite` waits for a gap in speech; `assertive` interrupts. Assertive is reserved for text that
 * has no other way of reaching the user, since interrupting is exactly as rude to a screen reader
 * user as it sounds.
 */
export function LiveRegion({
  text,
  assertive = false
}: {
  text: string
  assertive?: boolean
}): React.JSX.Element {
  return (
    <p
      className="sr-only"
      // No aria-label: on a live region it can be read in place of the content that changed.
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
      // The region must exist in the DOM before the text is put into it, or the change is not
      // observed and nothing is announced at all. Rendering it empty is deliberate.
      aria-atomic="true"
    >
      {text}
    </p>
  )
}
