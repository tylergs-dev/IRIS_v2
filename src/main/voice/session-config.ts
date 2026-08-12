import {
  ActivityHandling,
  EndSensitivity,
  Modality,
  StartSensitivity,
  ThinkingLevel,
  type LiveConnectConfig
} from '@google/genai'
import type { UserProfile } from '../../shared/types'
import { DEFAULT_VOICE, isVoiceName } from '../../shared/voices'
import { personaInstruction } from '../prompts/persona'

/**
 * Pinned deliberately. Every Live model is Preview with a two-week deprecation floor, so this
 * is the single place to change when Google moves. `gemini-3.1-pro-preview` is text-only and
 * will not connect here.
 */
export const LIVE_MODEL = 'gemini-3.1-flash-live-preview'

/** Connections are severed around the 10 minute mark regardless of session config. */
export const CONNECTION_LIFETIME_MS = 10 * 60 * 1000

/** Compression is a cost control, not just a length control: context is re-billed every turn. */
const COMPRESSION_TRIGGER_TOKENS = '25000'
const COMPRESSION_TARGET_TOKENS = '8000'

export interface SessionConfigOptions {
  profile: UserProfile
  tools: LiveConnectConfig['tools']
  resumptionHandle?: string | undefined
}

export function buildSessionConfig({
  profile,
  tools,
  resumptionHandle
}: SessionConfigOptions): LiveConnectConfig {
  return {
    // Native-audio models only support AUDIO output; transcription is the only way to get text.
    responseModalities: [Modality.AUDIO],
    systemInstruction: { parts: [{ text: personaInstruction(profile) }] },

    // Read defensively: an unknown name is rejected at setup, which would leave IRIS unable to
    // speak at all, and a profile edited by hand is a cheaper thing to shrug off than that.
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: isVoiceName(profile.voiceName) ? profile.voiceName : DEFAULT_VOICE
        }
      }
    },

    // Mirrors both sides of the conversation into the chat log.
    inputAudioTranscription: {},
    outputAudioTranscription: {},

    // Both are required: compression lifts the session length cap, resumption survives the
    // connection cap. Neither alone is enough.
    contextWindowCompression: {
      triggerTokens: COMPRESSION_TRIGGER_TOKENS,
      slidingWindow: { targetTokens: COMPRESSION_TARGET_TOKENS }
    },
    sessionResumption: resumptionHandle ? { handle: resumptionHandle } : {},

    realtimeInputConfig: {
      automaticActivityDetection: {
        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
        prefixPaddingMs: 300,
        // Below ~500ms utterances fragment and transcription quality measurably drops.
        silenceDurationMs: 700
      },
      activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS
    },

    // Conversational latency matters more than reasoning depth here; the hard thinking happens
    // in separate non-live calls for summarization.
    thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },

    ...(tools && tools.length > 0 ? { tools } : {})
  }
}
