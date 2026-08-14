/**
 * Short earcons for wake, sleep, and activity. Gemini's voice only starts after the Live session
 * is up, and going to sleep is otherwise silent, so without these a blind user has no confirmation
 * that the state actually changed.
 *
 * Wake rises; sleep falls. Done marks real completion. While work is in flight, soft steady beeps
 * climb gently with progress — real steps when known, a slow creep when not — and never reach
 * "finished" until the done chime.
 *
 * Frequencies stay in the 350–660 Hz band, where aging hearing is still reliable.
 */

export type Earcon = 'wake' | 'sleep' | 'done'

/** Audible progress never exceeds this; the done chime is the only completion signal. */
const PROGRESS_CAP = 0.85
const MIN_HZ = 380
const MAX_HZ = 520
const INDETERMINATE_TAU_MS = 10000
const BEEP_INTERVAL_MS = 2200
const CUE_PEAK = 0.055
const BEEP_DURATION = 0.16

let master: GainNode | null = null

let progressContext: AudioContext | null = null
let progressBus: GainNode | null = null
let progressCreepTimer: ReturnType<typeof setInterval> | null = null
let progressBeepTimer: ReturnType<typeof setTimeout> | null = null
let progressStartedAt = 0
let progressKnown: number | undefined = undefined
let progressDisplay = 0
let progressPaused = false

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
  } else if (kind === 'sleep') {
    note(context, bus, 659.25, now, 0.12, 0.16)
    note(context, bus, 440, now + 0.13, 0.28, 0.18)
  } else {
    note(context, bus, 523.25, now, 0.1, 0.12)
    note(context, bus, 659.25, now + 0.12, 0.14, 0.14)
  }
}

function hzForProgress(progress: number): number {
  const clamped = Math.min(Math.max(progress, 0), PROGRESS_CAP)
  return MIN_HZ + (clamped / PROGRESS_CAP) * (MAX_HZ - MIN_HZ)
}

function capProgress(progress: number): number {
  return Math.min(Math.max(progress, 0), PROGRESS_CAP)
}

/** Soft single beep at the current progress pitch. */
function playProgressBeep(context: AudioContext, dest: AudioNode, progress: number): void {
  const now = context.currentTime + 0.01
  softBeep(context, dest, hzForProgress(progress), now)
}

function softBeep(
  context: AudioContext,
  dest: AudioNode,
  frequency: number,
  start: number
): void {
  const osc = context.createOscillator()
  const gain = context.createGain()
  osc.type = 'sine'
  osc.frequency.value = frequency

  gain.gain.setValueAtTime(0, start)
  gain.gain.linearRampToValueAtTime(CUE_PEAK, start + 0.025)
  gain.gain.setValueAtTime(CUE_PEAK, start + BEEP_DURATION - 0.06)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + BEEP_DURATION)

  osc.connect(gain).connect(dest)
  osc.start(start)
  osc.stop(start + BEEP_DURATION + 0.02)
}

/** Start steady progress beeps. Pass known progress (0–1) when the task publishes it. */
export function startProgressCue(context: AudioContext, knownProgress?: number): void {
  void context.resume()
  stopProgressCue(context)

  progressContext = context
  progressStartedAt = Date.now()
  progressKnown = knownProgress !== undefined ? capProgress(knownProgress) : undefined
  progressDisplay = progressKnown ?? 0
  progressPaused = false

  const bus = context.createGain()
  bus.gain.value = 1
  bus.connect(context.destination)
  progressBus = bus

  playProgressBeep(context, bus, progressDisplay)
  progressCreepTimer = setInterval(() => tickProgressCreep(), 200)
  scheduleProgressBeep()
}

/** Nudge pitch on real task steps; plays one immediate beep when progress jumps forward. */
export function updateProgressCue(knownProgress?: number): void {
  if (knownProgress === undefined) {
    progressKnown = undefined
    return
  }

  const next = capProgress(knownProgress)
  const jumped = next > progressDisplay + 0.02
  progressKnown = next
  progressDisplay = Math.max(progressDisplay, next)

  if (jumped && progressContext && progressBus && !progressPaused) {
    playProgressBeep(progressContext, progressBus, progressDisplay)
  }
}

/** Silence beeps while IRIS speaks; progress position is preserved. */
export function pauseProgressCue(): void {
  if (!progressContext || progressPaused) return
  progressPaused = true
  clearProgressBeepTimer()
}

/** Resume the steady beep cadence after a brief spoken ack. */
export function resumeProgressCue(): void {
  if (!progressContext || !progressPaused) return
  progressPaused = false
  scheduleProgressBeep()
}

export function isProgressCueActive(): boolean {
  return progressContext !== null
}

function tickProgressCreep(): void {
  if (!progressContext || progressPaused || progressKnown !== undefined) return

  const elapsed = Date.now() - progressStartedAt
  const target = PROGRESS_CAP * (1 - Math.exp(-elapsed / INDETERMINATE_TAU_MS))
  if (target > progressDisplay) progressDisplay = target
}

function scheduleProgressBeep(): void {
  clearProgressBeepTimer()
  if (!progressContext || progressPaused) return

  progressBeepTimer = setTimeout(() => {
    progressBeepTimer = null
    if (!progressContext || !progressBus || progressPaused) return

    tickProgressCreep()
    playProgressBeep(progressContext, progressBus, progressDisplay)
    scheduleProgressBeep()
  }, BEEP_INTERVAL_MS)
}

function clearProgressBeepTimer(): void {
  if (!progressBeepTimer) return
  clearTimeout(progressBeepTimer)
  progressBeepTimer = null
}

export function stopProgressCue(_context?: AudioContext): void {
  clearProgressBeepTimer()
  if (progressCreepTimer) {
    clearInterval(progressCreepTimer)
    progressCreepTimer = null
  }

  if (progressBus && progressContext) {
    try {
      progressBus.disconnect()
    } catch {
      // Already disconnected.
    }
  }

  progressBus = null
  progressContext = null
  progressKnown = undefined
  progressDisplay = 0
  progressPaused = false
}

export function stopEarcons(context?: AudioContext): void {
  stopProgressCue(context)
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
