import type { VoiceState } from '@shared/types'
import { useStore } from '../store'
import {
  isProgressCueActive,
  pauseProgressCue,
  playEarcon,
  resumeProgressCue,
  startProgressCue,
  stopEarcons,
  updateProgressCue
} from './earcons'

const MIN_WORK_MS = 500

/**
 * Drives working/done earcons from task and email state only. Post-tool background work often
 * leaves voiceState at listening while a task is still running; conversely, voiceState
 * "thinking" also covers ordinary turn-taking after the user speaks, which must not trigger
 * loading sounds.
 */
export class ActivityController {
  private unsubscribers: Array<() => void> = []
  private isWorking = false
  private audioWorking = false
  private interrupted = false
  private workStartedAt = 0

  constructor(private readonly getContext: () => AudioContext | null) {}

  start(): void {
    this.unsubscribers.push(
      window.iris.on('task:update', () => this.recompute()),
      window.iris.on('email:snapshot', () => this.recompute()),
      window.iris.on('voice:state', (state) => this.onVoiceState(state)),
      window.iris.on('voice:flush', () => this.onInterrupt())
    )
    this.unsubscribers.push(useStore.subscribe(() => this.recompute()))
    this.recompute()
  }

  stop(): void {
    for (const off of this.unsubscribers) off()
    this.unsubscribers = []
    this.isWorking = false
    this.audioWorking = false
    this.interrupted = false
    stopEarcons(this.getContext() ?? undefined)
  }

  private onVoiceState(state: VoiceState): void {
    if (state === 'speaking') this.pauseAudio()
    else if (this.audioWorking && isProgressCueActive() && this.deriveWorking()) this.resumeAudio()
    this.recompute()
  }

  /** IRIS is speaking — pause beeps but keep progress position for when she stops. */
  private pauseAudio(): void {
    if (!this.audioWorking) return
    pauseProgressCue()
  }

  private resumeAudio(): void {
    if (!this.audioWorking || !this.soundsEnabled() || this.reducedMotion()) return
    resumeProgressCue()
  }

  /** Barge-in — stop beeps and suppress the completion chime for this work session. */
  private onInterrupt(): void {
    if (!this.audioWorking) return
    this.interrupted = true
    stopEarcons(this.getContext() ?? undefined)
    this.audioWorking = false
  }

  private deriveWorking(): boolean {
    const { task, email } = useStore.getState()
    if (task?.state === 'running') return true
    if (email?.busy) return true
    return false
  }

  /** Real task progress when published; otherwise the cue creeps on its own. */
  private deriveProgress(): number | undefined {
    const { task } = useStore.getState()
    if (task?.state === 'running' && task.progress !== undefined) return task.progress
    return undefined
  }

  private soundsEnabled(): boolean {
    const { profile } = useStore.getState()
    return profile?.activitySounds !== false
  }

  private reducedMotion(): boolean {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  private recompute(): void {
    const next = this.deriveWorking()
    const prev = this.isWorking

    if (next && !prev) {
      this.interrupted = false
      this.workStartedAt = Date.now()
      this.startAudio()
    } else if (!next && prev) {
      this.endAudio()
    } else if (!next && this.audioWorking) {
      this.haltAudio()
    } else if (next) {
      this.updateProgressAudio()
      this.syncAudioWhileWorking()
    }

    this.isWorking = next
  }

  private syncAudioWhileWorking(): void {
    if (!this.soundsEnabled() || this.reducedMotion()) {
      if (this.audioWorking) this.haltAudio()
      return
    }
    const { voiceState } = useStore.getState()
    if (voiceState === 'speaking') {
      if (this.audioWorking) this.pauseAudio()
      return
    }
    if (!this.audioWorking) {
      this.startAudio()
    } else if (isProgressCueActive()) {
      this.resumeAudio()
    }
  }

  private haltAudio(): void {
    if (!this.audioWorking) return
    stopEarcons(this.getContext() ?? undefined)
    this.audioWorking = false
  }

  private updateProgressAudio(): void {
    if (!this.audioWorking) return
    updateProgressCue(this.deriveProgress())
  }

  private startAudio(): void {
    if (!this.soundsEnabled() || this.reducedMotion()) return
    const { voiceState } = useStore.getState()
    if (voiceState === 'speaking') return
    const ctx = this.getContext()
    if (!ctx) return
    startProgressCue(ctx, this.deriveProgress())
    this.audioWorking = true
  }

  private endAudio(): void {
    const ctx = this.getContext()
    const elapsed = Date.now() - this.workStartedAt
    if (this.audioWorking) {
      stopEarcons(ctx ?? undefined)
      this.audioWorking = false
    }
    if (
      !this.interrupted &&
      elapsed >= MIN_WORK_MS &&
      this.soundsEnabled() &&
      ctx
    ) {
      playEarcon(ctx, 'done')
    }
    this.interrupted = false
  }
}
