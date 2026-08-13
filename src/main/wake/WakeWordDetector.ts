import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { InferenceSession, Tensor } from 'onnxruntime-node'
import { CAPTURE_FRAME_SAMPLES } from '../../shared/audio'
import { setHealth } from '../health'
import { createLogger } from '../log'

const log = createLogger('wake')

/**
 * livekit-wakeword's three-stage pipeline, running through onnxruntime-node. The two feature
 * models are the same frozen extractors openWakeWord published; only the classifier is specific
 * to "hey iris", trained with livekit-wakeword's conv-attention head.
 *
 * All three shapes below were read off the models rather than taken from documentation:
 *   melspectrogram : [1, samples]      -> [1, 1, frames, 32]
 *   embedding      : [N, 76, 32, 1]    -> [N, 1, 1, 96]
 *   classifier     : [1, 16, 96]       -> [1, 1]
 *
 * Inference matches the Python listener: a rolling ~2 s window is scored as a whole, not as
 * incremental 80 ms STFT hops. Training extracted embeddings from complete clips, and a short
 * wake phrase never fills a 2.1 s streaming buffer if silence is skipped.
 */
const MODEL_FILES = {
  melspectrogram: 'melspectrogram.onnx',
  embedding: 'embedding_model.onnx',
  classifier: 'iris.onnx'
} as const

/** 2 s at 16 kHz. Yields 197 mel frames and exactly 16 embedding windows. */
const WINDOW_SAMPLES = 32_000
const EMBEDDING_MEL_FRAMES = 76
const EMBEDDING_STRIDE = 8
const CLASSIFIER_EMBEDDINGS = 16
const MEL_BINS = 32
const EMBEDDING_SIZE = 96

/**
 * This classifier's observed scores on-device: room silence ~0.02, a spoken "hey iris" ~0.21–0.32.
 * livekit-wakeword's 0.6 default is for their highly confident "hey livekit" head and would never
 * fire here. 0.12 sits in the gap. Two consecutive 80 ms frames avoid a single noise blip.
 */
const DEFAULT_THRESHOLD = 0.12
/** Consecutive chunks over threshold. At 80 ms each, two is 160 ms of agreement. */
const REQUIRED_CONSECUTIVE = 2
/** After firing, ignore audio for long enough that one utterance cannot trigger twice. */
const REFRACTORY_MS = 2000

/**
 * Below this RMS (in int16 units) the latest frame is treated as silence and inference is
 * skipped. The 2 s window still advances, so the next spoken frame is scored with real context
 * rather than a buffer that never filled.
 */
const SILENCE_RMS = 120

/**
 * Electron's IPC often delivers ArrayBuffers as a Node Buffer (a Uint8Array view into a pool).
 * `new Int16Array(buffer)` then treats each byte as a sample, so length is 2560 instead of 1280
 * and every frame is dropped. Gemini never hits this because it copies with `Buffer.from`.
 */
function pcm16FromIpc(pcm: ArrayBuffer | ArrayBufferView): Int16Array | null {
  const bytes = ArrayBuffer.isView(pcm)
    ? new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    : new Uint8Array(pcm)
  if (bytes.byteLength !== CAPTURE_FRAME_SAMPLES * 2) return null
  if (bytes.byteOffset % 2 === 0) {
    return new Int16Array(bytes.buffer, bytes.byteOffset, CAPTURE_FRAME_SAMPLES)
  }
  const aligned = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(aligned).set(bytes)
  return new Int16Array(aligned)
}

export class WakeWordDetector {
  private sessions: {
    mel: InferenceSession
    embedding: InferenceSession
    classifier: InferenceSession
  } | null = null
  private loading: Promise<boolean> | null = null
  private TensorCtor: typeof Tensor | null = null

  /** Oldest sample first, stored at int16 scale so we can probe normalized vs raw at runtime. */
  private pcm = new Float32Array(WINDOW_SAMPLES)
  private pcmFilled = 0
  /** Copy taken before inference so a later append cannot mutate the in-flight window. */
  private pcmSnapshot = new Float32Array(WINDOW_SAMPLES)
  private scaledPcm = new Float32Array(WINDOW_SAMPLES)
  /** Reused so the 16 embedding windows are not allocated twelve times a second. */
  private embeddingWindows = new Float32Array(
    CLASSIFIER_EMBEDDINGS * EMBEDDING_MEL_FRAMES * MEL_BINS
  )
  private features = new Float32Array(CLASSIFIER_EMBEDDINGS * EMBEDDING_SIZE)

  private mutedUntil = 0
  private threshold = DEFAULT_THRESHOLD
  private listening = false
  private busy = false
  private onDetected: (() => void) | null = null
  private sawFrame = false
  private lastScoreLog = 0
  private consecutive = 0
  /** Divide int16 samples by this before the mel model. 32768 = livekit [-1, 1]; 1 = openWakeWord. */
  private pcmDivisor = 32768
  private probedScale = false

  private modelDir(): string {
    // Under resources in a packaged app: shipped with the code, not user state, so it is fine for
    // Velopack to replace it wholesale on update.
    return app.isPackaged
      ? path.join(process.resourcesPath, 'models')
      : path.join(app.getAppPath(), 'models')
  }

  /** Which models are present. Absence is a normal state, not an error: the hotkey still works. */
  missingModels(): string[] {
    const dir = this.modelDir()
    return Object.values(MODEL_FILES).filter((file) => !fs.existsSync(path.join(dir, file)))
  }

  isAvailable(): boolean {
    return this.missingModels().length === 0
  }

  isListening(): boolean {
    return this.listening && this.sessions !== null
  }

  setThreshold(value: number): void {
    if (value > 0 && value < 1) this.threshold = value
  }

  private async load(): Promise<boolean> {
    if (this.sessions) return true
    this.loading ??= this.doLoad().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  private async doLoad(): Promise<boolean> {
    const missing = this.missingModels()
    if (missing.length > 0) {
      log.info(`wake word unavailable, missing: ${missing.join(', ')}`)
      setHealth('wakeWord', 'offline')
      return false
    }

    setHealth('wakeWord', 'connecting')
    try {
      // Imported lazily: onnxruntime loads a large native library, and a machine that is missing
      // the fetched feature models should not pay that cost on every launch.
      const ort = await import('onnxruntime-node')
      this.TensorCtor = ort.Tensor
      const dir = this.modelDir()
      const options = {
        // One thread each: this runs continuously in the background and must not compete with
        // audio playback or the UI.
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
        graphOptimizationLevel: 'all' as const
      }

      const [mel, embedding, classifier] = await Promise.all([
        ort.InferenceSession.create(path.join(dir, MODEL_FILES.melspectrogram), options),
        ort.InferenceSession.create(path.join(dir, MODEL_FILES.embedding), options),
        ort.InferenceSession.create(path.join(dir, MODEL_FILES.classifier), options)
      ])
      this.sessions = { mel, embedding, classifier }
      log.info('wake word models loaded')
      // Reports that the wake word works, not whether it is listening this instant — otherwise the
      // indicator would drop out for the whole of every conversation, which reads as a fault.
      setHealth('wakeWord', 'online')
      return true
    } catch (error) {
      log.error('could not load the wake word models', error)
      setHealth('wakeWord', 'offline')
      return false
    }
  }

  /** Loads the models. Separate from listening, which starts and stops many times per session. */
  async prepare(onDetected: () => void): Promise<boolean> {
    this.onDetected = onDetected
    return this.load()
  }

  /**
   * Buffers are cleared on every transition rather than carried across: audio from before IRIS
   * went to sleep is not contiguous with audio from after, and splicing the two could assemble a
   * word out of two halves that were never spoken together.
   */
  setListening(listening: boolean): void {
    if (this.listening === listening) return
    this.listening = listening
    this.reset()
    log.info(listening ? 'listening for "hey iris"' : 'no longer listening for the wake word')
  }

  private reset(): void {
    this.pcm.fill(0)
    this.pcmFilled = 0
    this.sawFrame = false
    this.consecutive = 0
  }

  /** Suppresses detection while IRIS is speaking, so its own voice cannot wake it. */
  mute(ms = REFRACTORY_MS): void {
    this.mutedUntil = Date.now() + ms
    this.consecutive = 0
  }

  /**
   * One 80 ms chunk of int16 PCM. Stored at int16 scale; divided by `pcmDivisor` before the mel
   * model (32768 for livekit [-1, 1], or 1 if a runtime probe finds int16 scores higher).
   */
  async push(pcm: ArrayBuffer): Promise<void> {
    if (!this.listening || !this.sessions) return

    const samples = pcm16FromIpc(pcm)
    if (!samples) {
      if (!this.sawFrame) {
        const byteLength = ArrayBuffer.isView(pcm) ? pcm.byteLength : pcm.byteLength
        log.warn(
          `wake frame dropped: got ${byteLength} bytes (${Object.prototype.toString.call(pcm)}), ` +
            `expected ${CAPTURE_FRAME_SAMPLES * 2}`
        )
        this.sawFrame = true
      }
      return
    }

    if (!this.sawFrame) {
      this.sawFrame = true
      log.info('wake word receiving microphone frames')
    }

    const wasShort = this.pcmFilled < WINDOW_SAMPLES
    this.append(samples)
    if (wasShort && this.pcmFilled >= WINDOW_SAMPLES) {
      log.info('wake word window primed, scoring speech')
    }
    if (this.pcmFilled < WINDOW_SAMPLES) return
    if (Date.now() < this.mutedUntil) return
    if (this.busy) return

    let sumSquares = 0
    for (const sample of samples) sumSquares += sample * sample
    if (Math.sqrt(sumSquares / samples.length) < SILENCE_RMS) return

    this.busy = true
    try {
      await this.process(Math.sqrt(sumSquares / samples.length))
    } catch (error) {
      log.warn('wake word inference failed', error)
    } finally {
      this.busy = false
    }
  }

  private append(samples: Int16Array): void {
    this.pcm.copyWithin(0, CAPTURE_FRAME_SAMPLES)
    const tail = WINDOW_SAMPLES - CAPTURE_FRAME_SAMPLES
    for (let i = 0; i < samples.length; i += 1) {
      this.pcm[tail + i] = samples[i]
    }
    this.pcmFilled = Math.min(this.pcmFilled + samples.length, WINDOW_SAMPLES)
  }

  private async process(rms: number): Promise<void> {
    this.pcmSnapshot.set(this.pcm)

    if (!this.probedScale && rms >= 500) {
      this.probedScale = true
      const normalized = await this.score(this.pcmSnapshot, 32768)
      const int16 = await this.score(this.pcmSnapshot, 1)
      this.pcmDivisor = int16 > normalized ? 1 : 32768
      log.info(
        `wake scale probe: normalized=${normalized.toFixed(3)} int16=${int16.toFixed(3)}; ` +
          `using ${this.pcmDivisor === 1 ? 'int16' : 'normalized'}`
      )
      this.finishScore(Math.max(normalized, int16))
      return
    }

    const score = await this.score(this.pcmSnapshot, this.pcmDivisor)
    this.finishScore(score)
  }

  private scaleInto(source: Float32Array, divisor: number): Float32Array {
    if (divisor === 1) return source
    for (let i = 0; i < source.length; i += 1) this.scaledPcm[i] = source[i] / divisor
    return this.scaledPcm
  }

  private async score(audio: Float32Array, divisor: number): Promise<number> {
    const { mel, embedding, classifier } = this.sessions!
    const Tensor = this.TensorCtor!
    const input = this.scaleInto(audio, divisor)

    const melOut = await mel.run({
      input: new Tensor('float32', input, [1, input.length])
    })
    const melData = melOut[mel.outputNames[0]].data as Float32Array
    const melFrames = melData.length / MEL_BINS
    const nWindows = Math.floor((melFrames - EMBEDDING_MEL_FRAMES) / EMBEDDING_STRIDE) + 1
    if (nWindows < CLASSIFIER_EMBEDDINGS) return 0

    const firstWindow = nWindows - CLASSIFIER_EMBEDDINGS
    const windowBins = EMBEDDING_MEL_FRAMES * MEL_BINS
    for (let w = 0; w < CLASSIFIER_EMBEDDINGS; w += 1) {
      const src = (firstWindow + w) * EMBEDDING_STRIDE * MEL_BINS
      const dst = w * windowBins
      for (let i = 0; i < windowBins; i += 1) {
        this.embeddingWindows[dst + i] = melData[src + i] / 10 + 2
      }
    }

    const embOut = await embedding.run({
      input_1: new Tensor('float32', this.embeddingWindows, [
        CLASSIFIER_EMBEDDINGS,
        EMBEDDING_MEL_FRAMES,
        MEL_BINS,
        1
      ])
    })
    this.features.set(embOut[embedding.outputNames[0]].data as Float32Array)

    const scoreOut = await classifier.run({
      [classifier.inputNames[0]]: new Tensor('float32', this.features, [
        1,
        CLASSIFIER_EMBEDDINGS,
        EMBEDDING_SIZE
      ])
    })
    return (scoreOut[classifier.outputNames[0]].data as Float32Array)[0]
  }

  private finishScore(score: number): void {
    if (score >= 0.1 && Date.now() - this.lastScoreLog > 500) {
      this.lastScoreLog = Date.now()
      log.info(`wake score ${score.toFixed(3)} (threshold ${this.threshold})`)
    }

    if (score < this.threshold) {
      this.consecutive = 0
      return
    }

    this.consecutive += 1
    if (this.consecutive < REQUIRED_CONSECUTIVE) return

    log.info(`wake word detected (score ${score.toFixed(3)})`)
    this.consecutive = 0
    this.mute()
    this.onDetected?.()
  }
}

export const wakeWord = new WakeWordDetector()
