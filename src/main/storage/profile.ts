import type { SpeechPace, SummaryLength, UserProfile } from '../../shared/types'
import { JsonStore } from './json-store'

const defaults: UserProfile = {
  onboarded: false,
  onboardingDone: [],
  preferredName: null,
  city: null,
  region: null,
  timezone: null,
  speechPace: 'normal',
  summaryLength: 'short',
  digestSenders: [],
  nonDigestSenders: [],
  autoDetectDigests: true,
  interests: [],
  notes: null,
  knownLabels: []
}

let store: JsonStore<UserProfile> | null = null

/** Constructed lazily because it resolves its path from `app.getPath('userData')`. */
function getStore(): JsonStore<UserProfile> {
  store ??= new JsonStore('profile', defaults)
  return store
}

const listeners = new Set<(profile: UserProfile) => void>()

export function getProfile(): UserProfile {
  return getStore().get()
}

export function setProfile(patch: Partial<UserProfile>): UserProfile {
  const next = getStore().set(patch)
  for (const listener of listeners) listener(next)
  return next
}

export function onProfileChange(listener: (profile: UserProfile) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Words-per-minute guidance handed to the model, since TTS rate is not directly settable. */
export function paceGuidance(pace: SpeechPace): string {
  switch (pace) {
    case 'slow':
      return 'Speak slowly and unhurriedly, with clear pauses between sentences.'
    case 'fast':
      return 'Speak briskly and efficiently; the listener is comfortable with a fast pace.'
    default:
      return 'Speak at a natural, conversational pace.'
  }
}

/** Governs everything spoken, not just email summaries: it is how much detail they want at all. */
export function verbosityGuidance(length: SummaryLength): string {
  return length === 'detailed'
    ? 'They prefer a bit more detail. Give the full picture in a few sentences rather than the ' +
        'bare minimum, while still stopping when you have answered.'
    : 'They prefer things short. Lead with the answer in one or two sentences and let them ask ' +
        'for more.'
}

export async function flushProfile(): Promise<void> {
  await store?.settled()
}
