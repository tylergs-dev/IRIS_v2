import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { InferenceSession, Tensor } from 'onnxruntime-node'
import { CAPTURE_FRAME_SAMPLES } from '../../shared/audio'
import { setHealth } from '../health'
import { createLogger } from '../log'

const log = createLogger('wake')

/**
 * openWakeWord's three-stage pipeline, ported to onnxruntime-node. The two feature models are
 * shared and shipped as-is; only the small classifier is specific to "hey iris".
 *
 * All three shapes below were read off the models rather than taken from documentation:
 *   melspectrogram : [1, samples]      -> [1, 1, frames, 32]
 *   embedding      : [1, 76, 32, 1]    -> [1, 1, 1, 96]
 *   classifier     : [1, 16, 96]       -> [1, 1]
 */
const MODEL_FILES = {
  melspectrogram: 'melspectrogram.onnx',
  embedding: 'embedding_model.onnx',
  classifier: 'hey_iris.onnx'
} as const

/**
 * Frame arithmetic, verified empirically: the model emits `samples / 160 - 3` frames, so feeding
 * one 1280-sample chunk plus 480 samples of overlap yields exactly the 8 new frames that chunk is
 * responsible for. Dropping the overlap loses a frame per chunk and drifts the alignment the
 * classifier was trained on.
 */
const MEL_OVERLAP_SAMPLES = 480
const MEL_FRAMES_PER_CHUNK = 8

/**
 * One embedding covers 76 mel frames; consecutive embeddings step forward by one chunk. Together
 * with the classifier's 16-embedding window this means detection needs 26 consecutive chunks —
 * about 2.1 seconds of unbroken audio — before it can produce a score at all. That is why the
 * capture worklet streams continuously while asleep instead of gating on loudness: gating there
 * would cut the audio off long before the pipeline had filled.
 */
const EMBEDDING_MEL_FRAMES = 76
const CLASSIFIER_EMBEDDINGS = 16
const MEL_BINS = 32
const EMBEDDING_SIZE = 96

/**
 * Tuned for low false-accept rather than low false-reject, deliberately. A missed wake word costs
 * the user one repetition; a false one means IRIS starts listening and talking in a room where
 * nobody addressed it, which a blind user has no way to notice and no easy way to attribute.
 */
const DEFAULT_THRESHOLD = 0.6
/** Consecutive chunks over threshold. At 80 ms each, three is 240 ms of sustained agreement. */
const REQUIRED_CONSECUTIVE = 3
/** After firing, ignore audio for long enough that one utterance cannot trigger twice. */
const REFRACTORY_MS = 2000

/**
 * Below this RMS (in int16 units) the pipeline is skipped entirely. Roughly a quiet room; speech
 * at a normal distance is an order of magnitude above it. This is the VAD gate, and it is what
 * makes always-on detection affordable — silence costs nothing.
 */
const SILENCE_RMS = 120

export class WakeWordDetector {
  private sessions: {
    mel: InferenceSession
    embedding: InferenceSession
    classifier: InferenceSession
  } | null = null
  private loading: Promise<boolean> | null = null
  private TensorCtor: typeof Tensor | null = null

  /**
   * All three buffers are fixed-size and shifted in place. This loop runs twelve times a second
   * for as long as IRIS is asleep, so allocating per chunk would mean garbage collection pauses
   * during audio playback.
   */
  private raw = new Float32Array(CAPTURE_FRAME_SAMPLES + MEL_OVERLAP_SAMPLES)
  private rawFilled = 0

  /** Exactly one embedding window: oldest frame first, newest 8 frames written at the end. */
  private mel = new Float32Array(EMBEDDING_MEL_FRAMES * MEL_BINS)
  private melFrames = 0

  private features = new Float32Array(CLASSIFIER_EMBEDDINGS * EMBEDDING_SIZE)
  private embeddingCount = 0

  private consecutive = 0
  private mutedUntil = 0
  private threshold = DEFAULT_THRESHOLD
  private listening = false
  private busy = false
  private onDetected: (() => void) | null = null

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
      // Imported lazily: onnxruntime loads a large native library, and a user who never gets a
      // trained model should not pay that cost on every launch.
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
    this.rawFilled = 0
    this.raw.fill(0)
    this.mel.fill(0)
    this.melFrames = 0
    this.features.fill(0)
    this.embeddingCount = 0
    this.consecutive = 0
  }

  /** Suppresses detection while IRIS is speaking, so its own voice cannot wake it. */
  mute(ms = REFRACTORY_MS): void {
    this.mutedUntil = Date.now() + ms
    this.consecutive = 0
  }

  /**
   * One 80 ms chunk of int16 PCM. Values are fed to the model at int16 scale, not normalized to
   * [-1, 1]: openWakeWord was trained that way, and normalizing shifts every mel bin by about
   * 20 dB, which silently prevents the classifier from ever firing.
   */
  async push(pcm: ArrayBuffer): Promise<void> {
    if (!this.listening || !this.sessions) return
    if (this.busy) {
      // Inference is ~2 ms against an 80 ms budget, so this is rare; when it does happen the chunk
      // is dropped rather than queued. Dropping leaves a seam in the buffers, so the streak is
      // cleared: a spliced pair of half-words must not be able to complete an activation.
      this.consecutive = 0
      return
    }
    if (Date.now() < this.mutedUntil) return

    const samples = new Int16Array(pcm)
    if (samples.length !== CAPTURE_FRAME_SAMPLES) return

    let sumSquares = 0
    for (const sample of samples) sumSquares += sample * sample
    if (Math.sqrt(sumSquares / samples.length) < SILENCE_RMS) {
      // Silence still has to advance the buffers, or the frames either side of a quiet gap would
      // be spliced together into a word that was never said.
      this.consecutive = 0
      this.shiftRaw(samples)
      return
    }

    this.busy = true
    try {
      await this.process(samples)
    } catch (error) {
      log.warn('wake word inference failed', error)
    } finally {
      this.busy = false
    }
  }

  /**
   * The mel model needs the 480 samples immediately before the current chunk, which are the last
   * 480 of the previous one. So the buffer is [previous tail | current chunk], shifted each time.
   */
  private shiftRaw(samples: Int16Array): void {
    this.raw.copyWithin(0, CAPTURE_FRAME_SAMPLES)
    for (let i = 0; i < samples.length; i += 1) {
      this.raw[MEL_OVERLAP_SAMPLES + i] = samples[i]
    }
    this.rawFilled = Math.min(this.rawFilled + samples.length, this.raw.length)
  }

  private async process(samples: Int16Array): Promise<void> {
    const { mel, embedding, classifier } = this.sessions!
    const Tensor = this.TensorCtor!

    this.shiftRaw(samples)
    // Until the overlap holds real audio, the leading frames would be computed against zeros.
    // Skipping one chunk at startup is cheaper than a spurious activation.
    if (this.rawFilled < this.raw.length) return

    const melOut = await mel.run({
      input: new Tensor('float32', this.raw, [1, this.raw.length])
    })
    const melData = melOut[mel.outputNames[0]].data as Float32Array
    if (melData.length !== MEL_FRAMES_PER_CHUNK * MEL_BINS) {
      log.warn(`unexpected mel size ${melData.length}; wake word disabled`)
      this.listening = false
      return
    }

    // Shift out the oldest 8 frames and append the new ones, applying openWakeWord's scaling —
    // without which the embedding model sees values it was never trained on.
    this.mel.copyWithin(0, MEL_FRAMES_PER_CHUNK * MEL_BINS)
    const tail = this.mel.length - MEL_FRAMES_PER_CHUNK * MEL_BINS
    for (let i = 0; i < melData.length; i += 1) this.mel[tail + i] = melData[i] / 10 + 2

    this.melFrames = Math.min(this.melFrames + MEL_FRAMES_PER_CHUNK, EMBEDDING_MEL_FRAMES)
    if (this.melFrames < EMBEDDING_MEL_FRAMES) return

    const embOut = await embedding.run({
      input_1: new Tensor('float32', this.mel, [1, EMBEDDING_MEL_FRAMES, MEL_BINS, 1])
    })
    const vector = embOut[embedding.outputNames[0]].data as Float32Array

    this.features.copyWithin(0, EMBEDDING_SIZE)
    this.features.set(vector, this.features.length - EMBEDDING_SIZE)
    this.embeddingCount = Math.min(this.embeddingCount + 1, CLASSIFIER_EMBEDDINGS)
    if (this.embeddingCount < CLASSIFIER_EMBEDDINGS) return

    const scoreOut = await classifier.run({
      [classifier.inputNames[0]]: new Tensor('float32', this.features, [
        1,
        CLASSIFIER_EMBEDDINGS,
        EMBEDDING_SIZE
      ])
    })
    const score = (scoreOut[classifier.outputNames[0]].data as Float32Array)[0]

    if (score < this.threshold) {
      this.consecutive = 0
      return
    }

    this.consecutive += 1
    if (this.consecutive < REQUIRED_CONSECUTIVE) return

    log.info(`wake word detected (score ${score.toFixed(3)})`)
    this.consecutive = 0
    this.mute()
    // Cleared so the same utterance cannot contribute to a second activation.
    this.features.fill(0)
    this.embeddingCount = 0
    this.onDetected?.()
  }
}

export const wakeWord = new WakeWordDetector()
