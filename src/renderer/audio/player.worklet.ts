/// <reference lib="webworker" />

// Relative rather than the `@shared` alias: worklets are bundled by esbuild outside Vite's
// module graph, so Vite's alias map does not apply here.
import {
  OUTPUT_SAMPLE_RATE,
  PLAYBACK_PREBUFFER_SECONDS,
  PLAYBACK_RING_SECONDS,
  type PlayerCommand,
  type PlayerMessage
} from '../../shared/audio'

const RING_SECONDS = PLAYBACK_RING_SECONDS
const OUTPUT_RATE = OUTPUT_SAMPLE_RATE
const PREBUFFER_SAMPLES = Math.round(OUTPUT_RATE * PLAYBACK_PREBUFFER_SECONDS)

/**
 * Ring buffer rather than a queue of scheduled AudioBufferSourceNodes. Under network jitter a
 * schedule-clock approach produces audible clicks; this goes silent and re-primes instead, which
 * matters when audio is the entire interface.
 */
class PlayerProcessor extends AudioWorkletProcessor {
  private readonly ring = new Float32Array(OUTPUT_RATE * RING_SECONDS)
  private read = 0
  private write = 0

  private primed = false
  /** Set when the turn is known to be over, so the final sub-waterline tail still plays. */
  private drainRequested = false
  private announcedIdle = true

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<PlayerCommand>) => {
      switch (event.data.type) {
        case 'push':
          this.push(event.data.samples)
          this.announcedIdle = false
          break
        case 'drain':
          this.drainRequested = true
          break
        case 'flush':
          this.read = this.write
          this.primed = false
          this.drainRequested = false
          this.announcedIdle = true
          this.post({ type: 'flushed' })
          break
      }
    }
  }

  private push(samples: Float32Array): void {
    const capacity = this.ring.length
    for (let i = 0; i < samples.length; i += 1) {
      this.ring[this.write % capacity] = samples[i]
      this.write += 1
    }
    // Overflow means playback stalled while audio kept arriving; keep the newest audio.
    if (this.write - this.read > capacity) this.read = this.write - capacity
  }

  override process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true

    if (!this.primed) {
      const available = this.write - this.read
      if (available === 0 || (available < PREBUFFER_SAMPLES && !this.drainRequested)) {
        out.fill(0)
        if (available === 0 && !this.announcedIdle) {
          this.announcedIdle = true
          this.drainRequested = false
          this.post({ type: 'idle' })
        }
        return true
      }
      this.primed = true
    }

    for (let i = 0; i < out.length; i += 1) {
      out[i] = this.read < this.write ? this.ring[this.read++ % this.ring.length] : 0
    }

    // Underrun: fall back to waiting for the waterline rather than resetting a schedule clock.
    if (this.write === this.read) this.primed = false

    return true
  }

  private post(message: PlayerMessage): void {
    this.port.postMessage(message)
  }
}

registerProcessor('iris-player', PlayerProcessor)
