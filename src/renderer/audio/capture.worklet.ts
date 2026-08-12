/// <reference lib="webworker" />

// Relative rather than the `@shared` alias: worklets are bundled by esbuild outside Vite's
// module graph, so Vite's alias map does not apply here.
import {
  CAPTURE_FRAME_SAMPLES,
  type CaptureCommand,
  type CaptureMessage
} from '../../shared/audio'

const FRAME_SAMPLES = CAPTURE_FRAME_SAMPLES
const PREROLL_FRAMES = 4 // ~320 ms held back so speech onset is never clipped

/** Root-mean-square gate. Cheap, and enough to avoid uploading room silence. */
const OPEN_THRESHOLD = 0.012
const CLOSE_THRESHOLD = 0.006
/** Frames of quiet before declaring the utterance over (~480 ms). */
const HANGOVER_FRAMES = 6

/**
 * A live microphone in a silent room still has a noise floor two or three orders of magnitude
 * above this. Sustained levels below it mean the signal is muted somewhere below us, which
 * getUserMedia reports as success — so this is the only way to notice.
 */
const DEAD_INPUT_LEVEL = 1e-6
/** Frames of digital silence while listening before reporting it (~8 seconds). */
const DEAD_INPUT_FRAMES = 100

class CaptureProcessor extends AudioWorkletProcessor {
  private buffer = new Float32Array(FRAME_SAMPLES)
  private filled = 0

  // Parameterised so `.buffer` is an ArrayBuffer and can be transferred, rather than the
  // ArrayBufferLike that would also admit a SharedArrayBuffer.
  private preroll: Int16Array<ArrayBuffer>[] = []
  private speaking = false
  private quietFrames = 0
  private enabled = true
  private wakeListening = false
  private deadFrames = 0
  private reportedDead = false

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<CaptureCommand>) => {
      if (event.data.type === 'enable') {
        this.enabled = event.data.value
        if (!this.enabled) this.endUtterance()
      } else if (event.data.type === 'wakeListening') {
        this.wakeListening = event.data.value
      }
    }
  }

  override process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0]
    if (!channel) return true

    for (let i = 0; i < channel.length; i += 1) {
      this.buffer[this.filled++] = channel[i]
      if (this.filled === FRAME_SAMPLES) {
        this.emitFrame()
        this.filled = 0
      }
    }
    return true
  }

  private emitFrame(): void {
    let sumSquares = 0
    const pcm = new Int16Array(FRAME_SAMPLES)
    for (let i = 0; i < FRAME_SAMPLES; i += 1) {
      const sample = Math.max(-1, Math.min(1, this.buffer[i]))
      sumSquares += sample * sample
      // Asymmetric scaling: Int16 range is -32768..32767, so reusing 32767 for negatives clips.
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
    }
    const level = Math.sqrt(sumSquares / FRAME_SAMPLES)
    this.checkForDeadInput(level)

    if (!this.enabled) {
      // Asleep but listening for the wake word. Frames go out unbroken and ungated: the detector
      // needs about two seconds of continuous context before it can score at all, so gating on
      // loudness here would cut the audio off before it ever reached that point. It does its own,
      // cheaper gating on the far side.
      if (this.wakeListening) this.post({ type: 'frame', pcm: pcm.buffer }, [pcm.buffer])
      return
    }

    if (this.speaking) {
      this.post({ type: 'frame', pcm: pcm.buffer }, [pcm.buffer])
      if (level < CLOSE_THRESHOLD) {
        this.quietFrames += 1
        if (this.quietFrames >= HANGOVER_FRAMES) this.endUtterance()
      } else {
        this.quietFrames = 0
      }
      return
    }

    if (level >= OPEN_THRESHOLD) {
      this.speaking = true
      this.quietFrames = 0
      this.post({ type: 'activity', speaking: true, level })
      // Replay the held-back frames first so the server sees the start of the word.
      for (const frame of this.preroll) {
        this.post({ type: 'frame', pcm: frame.buffer }, [frame.buffer])
      }
      this.preroll = []
      this.post({ type: 'frame', pcm: pcm.buffer }, [pcm.buffer])
      return
    }

    this.preroll.push(pcm)
    if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift()
  }

  /**
   * Reported once per session, not repeatedly: if it is muted at the driver level nothing the user
   * does in IRIS will change it, and being told again every eight seconds would be worse than
   * useless. Counted only while listening, so a muted mic during sleep stays quiet.
   */
  private checkForDeadInput(level: number): void {
    if (this.reportedDead || !this.enabled) return
    if (level >= DEAD_INPUT_LEVEL) {
      this.deadFrames = 0
      return
    }
    this.deadFrames += 1
    if (this.deadFrames < DEAD_INPUT_FRAMES) return
    this.reportedDead = true
    this.post({ type: 'deadInput' })
  }

  private endUtterance(): void {
    if (!this.speaking) return
    this.speaking = false
    this.quietFrames = 0
    this.preroll = []
    this.post({ type: 'activity', speaking: false })
  }

  private post(message: CaptureMessage, transfer: Transferable[] = []): void {
    this.port.postMessage(message, transfer)
  }
}

registerProcessor('iris-capture', CaptureProcessor)
