import {
  INPUT_SAMPLE_RATE,
  OUTPUT_SAMPLE_RATE,
  type CaptureCommand,
  type CaptureMessage,
  type PlayerCommand
} from '@shared/audio'
import type { VoiceState } from '@shared/types'
import captureWorkletUrl from './capture.worklet.ts?worklet-url'
import playerWorkletUrl from './player.worklet.ts?worklet-url'
import { playEarcon, stopEarcons } from './earcons'
import { useStore } from '../store'

function workletUrl(path: string): string {
  return new URL(path, document.baseURI).href
}

/**
 * Owns both halves of the audio graph. Capture and playback must live in the renderer (Web Audio
 * is the only reliable path to the OS mixer), while the Gemini session lives in main, so PCM
 * crosses IPC in both directions.
 */
class AudioBridge {
  private captureContext: AudioContext | null = null
  private playbackContext: AudioContext | null = null
  private captureNode: AudioWorkletNode | null = null
  private playerNode: AudioWorkletNode | null = null
  private stream: MediaStream | null = null

  /** Playback generation. Anything older than this was invalidated by a barge-in. */
  private generation = 1
  private starting: Promise<void> | null = null
  /** Last voice state seen on this graph, so wake/sleep chimes fire only on the asleep boundary. */
  private lastVoiceState: VoiceState | null = null

  async start(): Promise<void> {
    this.starting ??= this.doStart()
    return this.starting
  }

  private async doStart(): Promise<void> {
    await this.startPlayback()
    await this.startCapture()
    // Subscribe before the first wake:listening replay. startWakeWord often emits that event
    // while getUserMedia is still opening, and a missed one means the worklet never sends
    // frames while IRIS is asleep.
    this.subscribe()
    const [state, health] = await Promise.all([
      window.iris.invoke('voice:getState'),
      window.iris.invoke('health:get')
    ])
    // Seed after subscribing so a wake that lands during startup is heard, and so a reload
    // of an already-awake session does not replay the wake chime. onVoiceState ignores
    // events until this is set.
    this.lastVoiceState = state
    this.toCapture({ type: 'enable', value: state !== 'asleep' })
    this.toCapture({
      type: 'wakeListening',
      value: state === 'asleep' && health.wakeWord === 'online'
    })
  }

  private toCapture(command: CaptureCommand): void {
    this.captureNode?.port.postMessage(command)
  }

  private toPlayer(command: PlayerCommand): void {
    this.playerNode?.port.postMessage(command)
  }

  private async startPlayback(): Promise<void> {
    // Pinned to 24 kHz, the Live API's fixed output rate, so nothing resamples on this path.
    const context = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE, latencyHint: 'interactive' })
    await context.audioWorklet.addModule(workletUrl(playerWorkletUrl))
    const node = new AudioWorkletNode(context, 'iris-player', { outputChannelCount: [1] })
    node.connect(context.destination)
    this.playbackContext = context
    this.playerNode = node
  }

  private async startCapture(): Promise<void> {
    try {
      // 16 kHz is the Live API's native input rate; letting Chromium resample from the device
      // rate avoids hand-rolled decimation, which aliases badly without an anti-alias filter.
      const context = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE })
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })

      await context.audioWorklet.addModule(workletUrl(captureWorkletUrl))
      const node = new AudioWorkletNode(context, 'iris-capture')
      context.createMediaStreamSource(stream).connect(node)

      // A worklet only runs while it is connected to the destination, but routing the microphone
      // to the speakers would create feedback, so the monitor tap is silenced.
      const mute = context.createGain()
      mute.gain.value = 0
      node.connect(mute).connect(context.destination)

      node.port.onmessage = (event: MessageEvent<CaptureMessage>) => {
        if (event.data.type === 'frame') {
          window.iris.sendAudioChunk(event.data.pcm)
        } else if (event.data.type === 'activity') {
          void window.iris.invoke('voice:speechActivity', event.data.speaking)
        } else {
          this.reportDeadInput()
        }
      }

      this.captureContext = context
      this.captureNode = node
      this.stream = stream
      useStore.setState({ micActive: true, micError: null })
    } catch (error) {
      const message = describeMicError(error)
      useStore.setState({ micActive: false, micError: message })
      // Playback still works when capture fails, so main can say this aloud — and has to, since
      // the user would otherwise sit waiting for an assistant that cannot hear them.
      void window.iris.invoke('voice:micProblem', message)
    }
  }

  /**
   * The mic opened but nothing is coming through it. Presented as a mute rather than a fault,
   * because that is nearly always what it is, and a physical switch is something the user can find
   * by touch.
   */
  private reportDeadInput(): void {
    const message =
      'I can reach your microphone, but nothing at all is coming through it, so I cannot hear ' +
      'you. It is usually muted — check for a mute switch on the microphone, headset, or keyboard. ' +
      'On Windows it can also be Settings, then Privacy and security, then Microphone. You can ' +
      'type to me until it is sorted out.'
    useStore.setState({ micError: message })
    void window.iris.invoke('voice:micProblem', message)
  }

  private subscribe(): void {
    window.iris.on('voice:audioOut', ({ generation, pcm }) => {
      if (generation < this.generation) return
      this.toPlayer({ type: 'push', samples: toFloat32(pcm) })
      void this.playbackContext?.resume()
    })

    window.iris.on('voice:flush', ({ generation }) => {
      this.generation = generation
      this.toPlayer({ type: 'flush' })
    })

    // Turn boundaries double as the drain signal, so the last sub-waterline chunk still plays
    // instead of being stranded below the prebuffer threshold.
    window.iris.on('voice:state', (state) => {
      this.onVoiceState(state)
      if (state !== 'speaking') this.toPlayer({ type: 'drain' })
      this.toCapture({ type: 'enable', value: state !== 'asleep' })
    })

    window.iris.on('wake:listening', (listening) => {
      this.toCapture({ type: 'wakeListening', value: listening })
    })
  }

  /**
   * Earcons only mark crossing asleep ↔ awake. Listening/thinking/speaking chatter is already
   * covered by IRIS's own voice, and chiming on every hop would just be noise.
   */
  private onVoiceState(state: VoiceState): void {
    const previous = this.lastVoiceState
    this.lastVoiceState = state
    if (!this.playbackContext || previous === null || previous === state) return
    if (previous === 'asleep') playEarcon(this.playbackContext, 'wake')
    else if (state === 'asleep') playEarcon(this.playbackContext, 'sleep')
  }

  stop(): void {
    stopEarcons(this.playbackContext ?? undefined)
    this.lastVoiceState = null
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    void this.captureContext?.close()
    void this.playbackContext?.close()
    this.stream = null
    this.captureContext = null
    this.playbackContext = null
    this.captureNode = null
    this.playerNode = null
    this.starting = null
    useStore.setState({ micActive: false })
  }
}

/**
 * Little-endian Int16 to Float32. Chunk lengths are always even here because each IPC message
 * carries a whole number of samples from the main process.
 */
function toFloat32(pcm: ArrayBuffer): Float32Array {
  const view = new DataView(pcm)
  const samples = new Float32Array(Math.floor(pcm.byteLength / 2))
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 0x8000
  }
  return samples
}

function describeMicError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError') {
    return (
      'I do not have permission to use the microphone. On Windows, open Settings, then Privacy ' +
      'and security, then Microphone, and turn on “Let desktop apps access your microphone”. ' +
      'You can still type to me in the meantime.'
    )
  }
  if (name === 'NotFoundError') {
    return 'I could not find a microphone. Please plug one in, then restart IRIS.'
  }
  return `I could not start the microphone: ${
    error instanceof Error ? error.message : String(error)
  }. You can still type to me.`
}

export const audio = new AudioBridge()
