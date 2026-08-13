/**
 * The Live API is asymmetric: it wants 16 kHz mono PCM16 in and always returns 24 kHz mono
 * PCM16 out. Both ends of the renderer audio graph are pinned to these rates so Chromium
 * does the resampling from the device rate rather than us doing it badly by hand.
 */
export const INPUT_SAMPLE_RATE = 16_000
export const OUTPUT_SAMPLE_RATE = 24_000

/** 1280 samples at 16 kHz is 80 ms, the frame size both Gemini Live and the wake word detector expect. */
export const CAPTURE_FRAME_SAMPLES = 1280

export const INPUT_MIME_TYPE = `audio/pcm;rate=${INPUT_SAMPLE_RATE}`

/** Playback waterline. Higher trades latency for resilience to network jitter. */
export const PLAYBACK_PREBUFFER_SECONDS = 0.15

/**
 * Gemini Live often bursts a whole reply at 3–4× realtime. Occupancy is then
 * duration × (1 − 1/burst), so a 20 s answer needs ~15 s of buffer — 10 s was only
 * enough for jitter and dropped the start of the sentence. 120 s holds ~160 s of
 * speech at 4×, which covers long email readings.
 */
export const PLAYBACK_RING_SECONDS = 120

/**
 * Worklet port messages. A `MessagePort` is typed as carrying `any`, so without these the whole
 * audio path is unchecked in exactly the place where a wrong field name is silent — a typo in a
 * message type would simply stop audio flowing, with no error anywhere.
 */
export type CaptureMessage =
  | { type: 'frame'; pcm: ArrayBuffer }
  | { type: 'activity'; speaking: boolean; level?: number }
  /**
   * The microphone is open and delivering digital silence rather than a room's noise floor —
   * a hardware mute switch, or Windows blocking microphone access at the OS level. Distinct from a
   * quiet room, and worth reporting: getUserMedia succeeded, so nothing else notices.
   */
  | { type: 'deadInput' }

export type CaptureCommand =
  | { type: 'enable'; value: boolean }
  /**
   * Keeps frames flowing while IRIS is asleep so the wake word can be heard. The main process
   * routes them to the detector, never to the Live session, which stays disconnected.
   */
  | { type: 'wakeListening'; value: boolean }

export type PlayerCommand =
  | { type: 'push'; samples: Float32Array }
  | { type: 'drain' }
  | { type: 'flush' }

export type PlayerMessage = { type: 'idle' } | { type: 'flushed' }
