import { GoogleGenAI, type LiveServerMessage, type Session } from '@google/genai'
import { INPUT_MIME_TYPE } from '../../shared/audio'
import type { VoiceState } from '../../shared/types'
import { addMessage, appendDelta, finalizeMessage } from '../chat/log'
import { setHealth } from '../health'
import { emit } from '../ipc/register'
import { createLogger } from '../log'
import { notice } from '../notify'
import { contextMessage, type ContextChannel } from '../prompts/persona'
import { getProfile } from '../storage/profile'
import { getSecret } from '../storage/secrets'
import { CostTracker } from './cost'
import { buildSessionConfig, LIVE_MODEL } from './session-config'
import { invokeTool, toolDeclarations } from './tools'

const log = createLogger('voice')

/** Pulls something loggable out of a websocket event whose type the SDK cannot give us. */
function describeEvent(event: unknown): string | undefined {
  if (typeof event === 'string') return event
  if (event && typeof event === 'object') {
    const record = event as Record<string, unknown>
    for (const key of ['reason', 'message'] as const) {
      const value = record[key]
      if (typeof value === 'string' && value) return value
    }
  }
  return undefined
}

/** Idle time before IRIS stops listening on its own, so the mic is not open indefinitely. */
const AUTO_SLEEP_MS = 3 * 60 * 1000

/** Backoff ceiling for reconnects that fail outright (as opposed to routine goAway cycles). */
const RECONNECT_MAX_MS = 30_000

export class VoiceSessionManager {
  private client: GoogleGenAI | null = null
  private session: Session | null = null
  private state: VoiceState = 'asleep'

  /** Kept across sleeps so waking resumes the same conversation rather than starting fresh. */
  private resumptionHandle: string | undefined
  private resumptionValid = false

  private connecting: Promise<boolean> | null = null
  private closingIntentionally = false
  private reconnectAttempts = 0

  private autoSleepTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private costTimer: NodeJS.Timeout | null = null

  /** Incremented on every barge-in so the renderer can discard audio already in flight. */
  private audioGeneration = 1

  private userMessageId: string | null = null
  private irisMessageId: string | null = null

  private speechOpen = false

  /**
   * Set when the user cancels locally. A server-side interrupt stops generation, but "stop" from
   * our side does not — the model keeps producing the rest of the turn, and without this that
   * audio would be tagged with the new generation and play anyway.
   */
  private suppressingTurn = false

  /**
   * A chunk can end mid-sample. Dropping that byte would shift every following sample by one
   * byte, which is heard as intermittent loud static, so it is carried into the next chunk.
   */
  private audioCarry: Buffer | null = null

  private readonly cost = new CostTracker()

  getState(): VoiceState {
    return this.state
  }

  getCostEstimate(): ReturnType<CostTracker['snapshot']> {
    return this.cost.snapshot()
  }

  // ---------------------------------------------------------------- public commands

  /** Opens a session if needed and starts listening. Resolves false if it could not connect. */
  async wake(): Promise<boolean> {
    this.touchActivity()
    if (this.session) {
      if (this.state === 'asleep') this.setState('listening')
      return true
    }
    return this.connect()
  }

  /**
   * Closes the connection rather than merely muting. An idle Live session is billed on
   * accumulated context, and the resumption handle keeps the conversation intact for two hours,
   * so disconnecting is both cheaper and safer than holding the socket open.
   */
  sleep(): void {
    this.clearTimer('autoSleepTimer')
    this.clearTimer('reconnectTimer')
    this.clearTimer('costTimer')
    this.closeSession()
    this.flushPlayback()
    this.finalizeTurn()
    this.suppressingTurn = false
    this.setState('asleep')
    setHealth('voice', 'offline')
  }

  /** Stop talking now, but keep listening. */
  stop(): void {
    if (this.state === 'speaking' || this.state === 'thinking') this.suppressingTurn = true
    this.flushPlayback()
    this.finalizeTurn()
    if (this.session) this.setState('listening')
  }

  async sendText(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    addMessage('user', trimmed)
    this.touchActivity()

    if (!(await this.wake())) return
    // sendClientContent is restricted to seeding history on 3.1; live turns must use
    // sendRealtimeInput even for text.
    this.session?.sendRealtimeInput({ text: trimmed })
    this.setState('thinking')
  }

  /**
   * Feeds the application's own observations to the model — skill progress, an email header to
   * read, an onboarding cue. Wakes IRIS if needed, because a skill that cannot speak is useless.
   */
  async inject(channel: ContextChannel, text: string): Promise<void> {
    if (!(await this.wake())) return
    this.session?.sendRealtimeInput({ text: contextMessage(channel, text) })
    this.touchActivity()
  }

  /**
   * Speaks an application message, for the notice path. Unlike `inject` it will not open a
   * session: notices are usually raised because something is already broken, and connecting in
   * order to complain about not being able to connect is a loop. Returns whether it will be said.
   */
  trySpeak(text: string): boolean {
    if (!this.session || this.state === 'asleep') return false
    this.session.sendRealtimeInput({ text: contextMessage('system', text) })
    this.touchActivity()
    return true
  }

  pushAudio(pcm: ArrayBuffer): void {
    if (!this.session || this.state === 'asleep' || !this.speechOpen) return
    this.session.sendRealtimeInput({
      audio: { data: Buffer.from(pcm).toString('base64'), mimeType: INPUT_MIME_TYPE }
    })
  }

  /**
   * Renderer-side VAD gate. Server VAD still decides turn boundaries, but gating what we upload
   * means we are not billed for silence. On close we flush so the server finalizes the turn
   * instead of waiting out its own silence timer.
   */
  setSpeechActivity(speaking: boolean): void {
    if (speaking === this.speechOpen) return
    this.speechOpen = speaking
    if (speaking) {
      this.touchActivity()
      return
    }
    if (this.session && this.state !== 'asleep') {
      this.session.sendRealtimeInput({ audioStreamEnd: true })
      if (this.state === 'listening') this.setState('thinking')
    }
  }

  // ---------------------------------------------------------------- connection

  private async connect(): Promise<boolean> {
    if (this.connecting) return this.connecting
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async doConnect(): Promise<boolean> {
    const apiKey = await getSecret('geminiApiKey')
    if (!apiKey) {
      setHealth('voice', 'offline')
      notice(
        'error',
        'I do not have a Gemini API key yet, so I cannot speak. Add one in Settings and I will ' +
          'be able to talk with you.'
      )
      return false
    }

    setHealth('voice', 'connecting')
    this.setState('thinking')
    this.client ??= new GoogleGenAI({ apiKey })

    try {
      const session = await this.client.live.connect({
        model: LIVE_MODEL,
        config: buildSessionConfig({
          profile: getProfile(),
          tools: [{ functionDeclarations: toolDeclarations() }],
          resumptionHandle: this.resumptionValid ? this.resumptionHandle : undefined
        }),
        callbacks: {
          onopen: () => log.info('live session open'),
          onmessage: (message) => this.onMessage(message),
          // `ErrorEvent` and `CloseEvent` are DOM types the SDK references but the main process
          // has no DOM lib, so these arrive untyped and have to be narrowed by hand.
          onerror: (event: unknown) => log.error('live session error', describeEvent(event)),
          onclose: (event: unknown) => this.onClose(describeEvent(event))
        }
      })

      this.session = session
      this.closingIntentionally = false
      this.reconnectAttempts = 0
      // A reconnect mid-turn means the turnComplete that would have cleared this never arrives.
      this.suppressingTurn = false
      this.cost.start()
      this.startCostReporting()
      setHealth('voice', 'online')
      this.setState('listening')
      this.touchActivity()
      return true
    } catch (error) {
      log.error('could not open live session', error)
      setHealth('voice', 'offline')
      this.setState('asleep')
      notice(
        'error',
        'I could not reach the voice service just now. You can still type to me, and I will ' +
          'keep trying in the background.'
      )
      this.scheduleReconnect()
      return false
    }
  }

  private onClose(reason?: string): void {
    this.session = null
    this.clearTimer('costTimer')
    if (this.closingIntentionally) {
      this.closingIntentionally = false
      return
    }
    log.warn('live session closed unexpectedly', reason)
    setHealth('voice', 'connecting')
    // Routine: the server severs the connection roughly every ten minutes. Resume, don't restart.
    if (this.state !== 'asleep') this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.state === 'asleep') return
    const delay = Math.min(RECONNECT_MAX_MS, 500 * 2 ** this.reconnectAttempts++)
    log.info(`reconnecting in ${delay}ms`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.state !== 'asleep') void this.connect()
    }, delay)
  }

  private closeSession(): void {
    if (!this.session) return
    this.closingIntentionally = true
    try {
      this.session.close()
    } catch (error) {
      log.warn('error closing session', error)
    }
    this.session = null
  }

  // ---------------------------------------------------------------- inbound messages

  private onMessage(message: LiveServerMessage): void {
    if (message.setupComplete) log.debug('setup complete')

    if (message.sessionResumptionUpdate) {
      const { newHandle, resumable } = message.sessionResumptionUpdate
      // `resumable` goes false during tool calls and generation; only keep known-good handles.
      if (resumable && newHandle) {
        this.resumptionHandle = newHandle
        this.resumptionValid = true
      }
    }

    if (message.goAway) {
      // Arrives about a minute before the server drops us. Reconnect on our terms.
      log.info('goAway received', message.goAway.timeLeft)
      this.closeSession()
      this.scheduleReconnect()
      return
    }

    if (message.usageMetadata) {
      this.cost.record(message.usageMetadata)
    }

    if (message.serverContent) this.onServerContent(message.serverContent)

    if (message.toolCallCancellation) {
      log.info('tool calls cancelled', message.toolCallCancellation.ids)
    }

    if (message.toolCall?.functionCalls?.length) {
      void this.onToolCall(message.toolCall.functionCalls)
    }
  }

  private onServerContent(content: NonNullable<LiveServerMessage['serverContent']>): void {
    if (content.interrupted) {
      // Barge-in. Both halves matter: clear the renderer's ring buffer and invalidate anything
      // already sent over IPC, or stale audio keeps playing after the flush.
      this.flushPlayback()
      this.finalizeTurn()
      this.setState('listening')
      return
    }

    // Input transcription is never suppressed: what the user said belongs in the log regardless.
    if (content.inputTranscription?.text) {
      this.appendTranscript('user', content.inputTranscription.text)
      this.touchActivity()
    }

    if (!this.suppressingTurn) {
      if (content.outputTranscription?.text) {
        this.appendTranscript('iris', content.outputTranscription.text)
      }

      // A single 3.1 event can carry several parts at once; iterating only the first would
      // silently drop audio.
      for (const part of content.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          this.emitAudio(Buffer.from(part.inlineData.data, 'base64'))
          if (this.state !== 'speaking') this.setState('speaking')
        } else if (part.text) {
          this.appendTranscript('iris', part.text)
        }
      }
    }

    if (content.turnComplete) {
      this.suppressingTurn = false
      this.finalizeTurn()
      if (this.state !== 'asleep') this.setState('listening')
    }
  }

  private async onToolCall(
    calls: NonNullable<NonNullable<LiveServerMessage['toolCall']>['functionCalls']>
  ): Promise<void> {
    this.setState('thinking')
    const functionResponses = await Promise.all(
      calls.map(async (call) => ({
        id: call.id,
        name: call.name,
        response: await invokeTool(call.name ?? '', call.args ?? {})
      }))
    )
    // The session may have cycled while a tool ran; dropping the response is correct, since the
    // model on the new connection has no pending call to satisfy.
    this.session?.sendToolResponse({ functionResponses })
  }

  // ---------------------------------------------------------------- helpers

  private appendTranscript(role: 'user' | 'iris', text: string): void {
    const key = role === 'user' ? 'userMessageId' : 'irisMessageId'
    let id = this[key]
    if (!id) {
      id = addMessage(role, text, true).id
      this[key] = id
      return
    }
    appendDelta(id, text)
  }

  private finalizeTurn(): void {
    if (this.userMessageId) finalizeMessage(this.userMessageId)
    if (this.irisMessageId) finalizeMessage(this.irisMessageId)
    this.userMessageId = null
    this.irisMessageId = null
  }

  private emitAudio(chunk: Buffer): void {
    let payload = this.audioCarry ? Buffer.concat([this.audioCarry, chunk]) : chunk
    this.audioCarry = null

    if (payload.byteLength % 2 === 1) {
      this.audioCarry = payload.subarray(payload.byteLength - 1)
      payload = payload.subarray(0, payload.byteLength - 1)
    }
    if (payload.byteLength === 0) return

    // Copied rather than referenced: subarray views share the decode buffer, and structured
    // clone would otherwise send the whole thing.
    const pcm = new ArrayBuffer(payload.byteLength)
    Buffer.from(pcm).set(payload)
    emit('voice:audioOut', { generation: this.audioGeneration, pcm })
  }

  private flushPlayback(): void {
    this.audioGeneration += 1
    this.audioCarry = null
    emit('voice:flush', { generation: this.audioGeneration })
  }

  private setState(state: VoiceState): void {
    if (this.state === state) return
    this.state = state
    emit('voice:state', state)
    for (const listener of this.stateListeners) listener(state)
  }

  private readonly stateListeners = new Set<(state: VoiceState) => void>()

  /** In-process notification, for the wake word detector which lives outside the IPC layer. */
  onStateChange(listener: (state: VoiceState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  private touchActivity(): void {
    this.clearTimer('autoSleepTimer')
    this.autoSleepTimer = setTimeout(() => {
      log.info('auto-sleeping after inactivity')
      this.sleep()
    }, AUTO_SLEEP_MS)
  }

  private startCostReporting(): void {
    this.clearTimer('costTimer')
    this.costTimer = setInterval(() => emit('voice:cost', this.cost.snapshot()), 15_000)
  }

  private clearTimer(key: 'autoSleepTimer' | 'reconnectTimer' | 'costTimer'): void {
    const timer = this[key]
    if (!timer) return
    if (key === 'costTimer') clearInterval(timer)
    else clearTimeout(timer)
    this[key] = null
  }

  dispose(): void {
    this.sleep()
    this.cost.reset()
  }
}

export const voice = new VoiceSessionManager()
