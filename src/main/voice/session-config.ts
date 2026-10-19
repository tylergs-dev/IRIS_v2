import {
  ActivityHandling,
  EndSensitivity,
  Modality,
  StartSensitivity,
  TurnCoverage,
  type LiveConnectConfig
} from '@google/genai'
import type { UserProfile } from '../../shared/types'
import { DEFAULT_VOICE, isVoiceName } from '../../shared/voices'
import { personaInstruction } from '../prompts/persona'

/**
 * Pinned deliberately, and the single place to change when Google moves. `gemini-3.8-live` is
 * the stable low-latency Live model; its Extended Thinking sibling reasons in the background
 * and reports idleness through `interactionStatus` rather than `turnComplete`, so switching to
 * it would mean reworking the state machine in VoiceSessionManager. `gemini-3.1-pro-preview` is
 * text-only and will not connect here.
 */
export const LIVE_MODEL = 'gemini-3.8-live'

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
      activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
      // 3.8 defaults to TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO. IRIS never sends video, and
      // the renderer already gates uploads to speech, so a turn is speech activity and nothing
      // else.
      turnCoverage: TurnCoverage.TURN_INCLUDES_ONLY_ACTIVITY
    },

    // No thinkingConfig: `gemini-3.8-live` rejects `thinkingLevel` at setup. Its interleaved
    // reasoning is always on and not tunable. The hard thinking happens in separate non-live
    // calls for summarization. Proactive audio is likewise permanently on and affective dialogue
    // has been removed from the API, so neither is set here.

    ...(tools && tools.length > 0 ? { tools } : {})
  }
}
