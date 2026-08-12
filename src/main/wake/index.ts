import { emit } from '../ipc/register'
import { createLogger } from '../log'
import { notice } from '../notify'
import { voice } from '../voice/VoiceSessionManager'
import { wakeWord } from './WakeWordDetector'

const log = createLogger('wake')

/** Long enough that the tail of IRIS's own last sentence cannot wake it straight back up. */
const SLEEP_SETTLE_MS = 1000

/**
 * Detection runs only while IRIS is asleep. Once awake, the Live session's own server VAD owns
 * turn-taking, and running both would let IRIS wake itself the moment it said its own name.
 */
export async function startWakeWord(): Promise<void> {
  const missing = wakeWord.missingModels()
  if (missing.length > 0) {
    // Not worth speaking about: the hotkey is a first-class path rather than a fallback, and the
    // classifier has to be trained per wake word, so most installs will not have one.
    log.info(`wake word not enabled (missing ${missing.join(', ')}); hotkey remains available`)
    return
  }

  // Health is reported by the detector itself, which is the only thing that knows whether the
  // models actually loaded.
  const ready = await wakeWord.prepare(() => {
    log.info('waking on "hey iris"')
    void voice.wake()
  })

  if (!ready) {
    notice(
      'warning',
      'I could not start listening for “hey iris”. You can still wake me with Control Shift I, ' +
        'or with the Wake button.'
    )
    return
  }

  setListening(voice.getState() === 'asleep')

  voice.onStateChange((state) => {
    if (state !== 'asleep') {
      setListening(false)
      return
    }
    wakeWord.mute(SLEEP_SETTLE_MS)
    setListening(true)
  })
}

function setListening(listening: boolean): void {
  wakeWord.setListening(listening)
  // Tells the renderer whether to keep sending frames while the Live session is disconnected.
  emit('wake:listening', listening)
}
