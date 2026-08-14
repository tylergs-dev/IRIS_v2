import { randomUUID } from 'node:crypto'
import type { SkillId, TaskStatus } from '../../shared/types'
import { emit } from '../ipc/register'
import { createLogger } from '../log'
import type { ContextChannel } from '../prompts/persona'
import { voice } from '../voice/VoiceSessionManager'

const log = createLogger('task')

/**
 * Gemini Live cannot speak until a tool handler returns. Slow skills return this note immediately
 * so IRIS acknowledges in a few words, then narrate progress over the context channel.
 */
export const STARTING_ACK =
  'Say only one to three words that you have started, then wait quietly. Do not explain.'

/** When the app will narrate the result — speaking over it causes duplicates. */
export const SILENT_ACK =
  'Do not speak. The app will read the next part on its own. Wait in complete silence.'

/**
 * Progress is injected into the live session as text, which the model then speaks. Injecting
 * faster than the model can talk just queues narration it will never catch up on, so routine
 * progress is throttled.
 */
const PROGRESS_INTERVAL_MS = 2500

export class Task {
  readonly id = randomUUID()
  private readonly steps: string[] = []
  private state: TaskStatus['state'] = 'running'
  private progress: number | undefined

  private lastInjectedAt = 0
  private pending: string | null = null
  private flushTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly skill: SkillId,
    private readonly channel: ContextChannel,
    private readonly title: string
  ) {
    log.info(`start ${skill}: ${title}`)
    displayedTaskId = this.id
    this.publish()
  }

  private publish(): void {
    // An older task that is still running must not overwrite the newest one's panel.
    if (displayedTaskId !== this.id) return
    const status: TaskStatus = {
      taskId: this.id,
      skill: this.skill,
      title: this.title,
      steps: this.steps.slice(),
      state: this.state,
      ...(this.progress === undefined ? {} : { progress: this.progress })
    }
    emit('task:update', status)
  }

  /** Routine progress. Always shown in the panel; spoken at most every few seconds. */
  step(message: string, progress?: number): void {
    this.steps.push(message)
    if (progress !== undefined) this.progress = progress
    this.publish()
    this.throttledInject(message)
  }

  /** Something the user must hear, such as a result or a failure. Never throttled. */
  async narrate(message: string): Promise<void> {
    this.steps.push(message)
    this.publish()
    this.cancelFlush()
    this.lastInjectedAt = Date.now()
    await voice.inject(this.channel, message)
  }

  private throttledInject(message: string): void {
    const elapsed = Date.now() - this.lastInjectedAt
    if (elapsed >= PROGRESS_INTERVAL_MS) {
      this.lastInjectedAt = Date.now()
      void voice.inject(this.channel, `Progress update, mention this briefly: ${message}`)
      return
    }

    // Keep only the newest message and deliver it once the window opens, so the user hears where
    // the task actually is rather than a backlog of where it was.
    this.pending = message
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const next = this.pending
      this.pending = null
      if (!next || this.state !== 'running') return
      this.lastInjectedAt = Date.now()
      void voice.inject(this.channel, `Progress update, mention this briefly: ${next}`)
    }, PROGRESS_INTERVAL_MS - elapsed)
  }

  private cancelFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.pending = null
  }

  async finish(message: string): Promise<void> {
    this.state = 'done'
    this.progress = 1
    this.cancelFlush()
    this.steps.push('Finished')
    this.publish()
    await voice.inject(this.channel, message)
    this.clearPanelSoon()
  }

  async fail(message: string): Promise<void> {
    this.state = 'error'
    this.cancelFlush()
    this.steps.push('Failed')
    this.publish()
    log.warn(`task failed: ${this.title}`)
    await voice.inject(this.channel, message)
    this.clearPanelSoon()
  }

  /** Left visible briefly so a sighted helper can read the outcome, then unmounted. */
  private clearPanelSoon(): void {
    setTimeout(() => {
      // A later task may already own the panel; clearing it then would hide live progress.
      if (displayedTaskId === this.id) {
        displayedTaskId = null
        emit('task:update', null)
      }
    }, 6000)
  }
}

/** The panel shows one task at a time, so the newest start wins. */
let displayedTaskId: string | null = null

export function startTask(skill: SkillId, channel: ContextChannel, title: string): Task {
  return new Task(skill, channel, title)
}
