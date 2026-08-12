/**
 * Short earcons for wake and sleep. Gemini's voice only starts after the Live session is up, and
 * going to sleep is otherwise silent, so without these a blind user has no confirmation that the
 * state actually changed.
 *
 * Wake rises; sleep falls. Same interval both ways, so the pair is easy to learn and hard to
 * confuse even at a modest volume. Frequencies stay in the 400–800 Hz band, where aging hearing
 * is still reliable.
 */

export type Earcon = 'wake' | 'sleep'

let master: GainNode | null = null

export function playEarcon(context: AudioContext, kind: Earcon): void {
  void context.resume()
  stopEarcons(context)

  const bus = context.createGain()
  bus.connect(context.destination)
  master = bus

  const now = context.currentTime + 0.01
  if (kind === 'wake') {
    note(context, bus, 440, now, 0.11, 0.16)
    note(context, bus, 659.25, now + 0.12, 0.18, 0.2)
  } else {
    note(context, bus, 659.25, now, 0.12, 0.16)
    note(context, bus, 440, now + 0.13, 0.28, 0.18)
  }
}

export function stopEarcons(context?: AudioContext): void {
  if (!master) return
  const now = context?.currentTime ?? 0
  try {
    master.gain.cancelScheduledValues(now)
    master.gain.setValueAtTime(0, now)
    master.disconnect()
  } catch {
    // Already stopped or the context was closed.
  }
  master = null
}

function note(
  context: AudioContext,
  dest: AudioNode,
  frequency: number,
  start: number,
  duration: number,
  peak: number
): void {
  const osc = context.createOscillator()
  const gain = context.createGain()
  osc.type = 'sine'
  osc.frequency.value = frequency

  gain.gain.setValueAtTime(0, start)
  gain.gain.linearRampToValueAtTime(peak, start + 0.012)
  const release = Math.min(0.08, duration * 0.45)
  gain.gain.setValueAtTime(peak, start + duration - release)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)

  osc.connect(gain).connect(dest)
  osc.start(start)
  osc.stop(start + duration + 0.02)
}
