import type { VoiceName } from './voices'

export type VoiceState = 'asleep' | 'listening' | 'thinking' | 'speaking'

export type ChatRole = 'user' | 'iris' | 'system'

export interface ChatMessage {
  id: string
  role: ChatRole
  text: string
  /** Marks a message still being streamed, so the UI can avoid announcing it as final. */
  streaming?: boolean
  at: number
}

export type SkillId = 'email' | 'search' | 'browse' | 'onboarding' | 'update'

export interface TaskStatus {
  taskId: string
  skill: SkillId
  title: string
  /** Newest last. The mini panel shows the tail; the whole list is the audit trail. */
  steps: string[]
  detail?: string
  progress?: number
  state: 'running' | 'done' | 'error'
}

export type SpeechPace = 'slow' | 'normal' | 'fast'
export type SummaryLength = 'short' | 'detailed'

/**
 * The five questions worth asking before the user has seen the app work. Everything else in the
 * spec's list is more useful offered later, once they know what IRIS does.
 */
export const ONBOARDING_TOPICS = ['name', 'location', 'pace', 'summary', 'digests'] as const
export type OnboardingTopic = (typeof ONBOARDING_TOPICS)[number]

/** Publications whose emails are walked as article lists. Editable in Settings. */
export const DEFAULT_DIGEST_SENDERS = [
  'Morningstar',
  'TheStreet',
  'Kiplinger',
  'Arizona News',
  'Consumer Reports',
  'Vida Lifestyles'
] as const

export interface UserProfile {
  /** False until onboarding completes, which gates the first-run flow. */
  onboarded: boolean
  /**
   * Which questions have been dealt with, answered or declined. Tracked rather than inferred so a
   * first run interrupted halfway resumes where it stopped instead of starting over, and so
   * "I'd rather not say" is not mistaken for an unanswered question.
   */
  onboardingDone: OnboardingTopic[]
  preferredName: string | null
  city: string | null
  region: string | null
  timezone: string | null
  /** Which prebuilt Gemini voice IRIS speaks in. Only applied when a session is opened. */
  voiceName: VoiceName
  speechPace: SpeechPace
  summaryLength: SummaryLength
  /** Senders always treated as link-digest newsletters, bypassing heuristics. */
  digestSenders: string[]
  /** Senders never treated as link-digest newsletters. */
  nonDigestSenders: string[]
  autoDetectDigests: boolean
  /**
   * True once the built-in article-review list has been written to this profile. Distinguishes a
   * first launch (empty list should be seeded) from the user later clearing every entry.
   */
  articleReviewListSeeded: boolean
  interests: string[]
  notes: string | null
  /**
   * Gmail folder names, cached at connect time. Held here so the model knows what "move it to
   * receipts" can mean without spending a tool call to find out.
   */
  knownLabels: string[]
}

export type SecretName =
  | 'geminiApiKey'
  | 'tavilyApiKey'
  | 'googleRefreshToken'
  | 'googleClientId'
  | 'googleClientSecret'

export type SecretsPresence = Record<SecretName, boolean>

export interface GoogleAccount {
  email: string
}

/** Header-only view of a message, from the cheap `format: 'metadata'` fetch. */
export interface EmailHeader {
  id: string
  threadId: string
  fromName: string
  fromAddress: string
  subject: string
  date: string
  snippet: string
}

export interface EmailLink {
  text: string
  href: string
}

export interface EmailBody {
  text: string
  links: EmailLink[]
  isHtmlDerived: boolean
}

export type EmailModePhase =
  | 'idle'
  | 'fetchingQueue'
  | 'readingHeader'
  | 'awaitingHeaderChoice'
  | 'summarizing'
  | 'awaitingPostSummaryChoice'
  | 'articleReview'
  | 'exhausted'

export interface EmailModeSnapshot {
  phase: EmailModePhase
  /** Index into the queue of the message being handled, or null when none. */
  position: number | null
  queueLength: number
  current: EmailHeader | null
  articleIndex: number | null
  articleCount: number | null
  canUndo: boolean
}

export interface SavedArticle {
  id: string
  title: string
  href: string
  sourceSender: string
  savedAt: number
}

export interface SearchCitation {
  title: string
  url: string
}

export interface SearchAnswer {
  answer: string
  citations: SearchCitation[]
}

export interface LabelInfo {
  id: string
  name: string
}

export type ConnectionState = 'offline' | 'connecting' | 'online'

export interface ServiceHealth {
  voice: ConnectionState
  gmail: ConnectionState
  search: ConnectionState
  /** Whether Edge or Chrome could actually be launched. Unknown until first use. */
  browser: ConnectionState
  /** Offline whenever the models are absent, which is a supported state — the hotkey remains. */
  wakeWord: ConnectionState
}

/** Rolling estimate of Live API spend, surfaced so long sessions are not a silent cost. */
export interface CostEstimate {
  sessionSeconds: number
  audioInSeconds: number
  audioOutSeconds: number
  estimatedUsd: number
}
