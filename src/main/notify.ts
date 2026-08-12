import { emit } from './ipc/register'
import { createLogger } from './log'

const log = createLogger('notify')

/** Returns whether the text was accepted for speaking. Set by the voice layer at startup. */
type Speaker = (text: string) => boolean

let speaker: Speaker | null = null

/**
 * Late-bound rather than imported: the voice manager raises notices itself, so importing it here
 * would be a cycle, and the notice path has to keep working when voice is exactly what is broken.
 */
export function setNoticeSpeaker(fn: Speaker): void {
  speaker = fn
}

/** Suppresses the identical warning repeating while the underlying fault persists. */
const REPEAT_WINDOW_MS = 60_000
const lastSpoken = new Map<string, number>()

export interface NoticeOptions {
  /**
   * Set for text IRIS has already said, or is about to say, in its own voice. Keeps the screen
   * reader from reading a second copy over the top of it.
   */
  alreadySpoken?: boolean
  /** Skips speaking, for notices that would be noise out loud. Rare, and worth justifying. */
  silent?: boolean
}

/**
 * The single path for telling the user something went wrong. Every notice must reach them by ear,
 * because the intended user cannot see the screen at all — a warning that is only drawn has not
 * been delivered.
 *
 * There are two ways to be heard, and which one applies depends on what is broken:
 *   - IRIS says it, when the voice session is up. This is the good case and it sounds like IRIS.
 *   - The screen reader says it, when voice is down — which is when most notices happen. The
 *     renderer puts undelivered text in an assertive live region for exactly this reason.
 */
export function notice(
  severity: 'info' | 'warning' | 'error',
  text: string,
  options: NoticeOptions = {}
): void {
  let spoken = options.alreadySpoken ?? false

  if (!spoken && !options.silent && speaker) {
    const now = Date.now()
    const previous = lastSpoken.get(text)
    if (previous !== undefined && now - previous < REPEAT_WINDOW_MS) {
      // Still shown, so it stays readable and the live region is not re-triggered.
      spoken = true
    } else if (speaker(text)) {
      lastSpoken.set(text, now)
      spoken = true
    }
  }

  if (severity === 'error') log.warn(`notice (spoken: ${spoken}): ${text}`)
  emit('notice', { severity, text, spoken })
}
