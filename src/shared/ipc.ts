import type {
  ChatMessage,
  CostEstimate,
  EmailModeSnapshot,
  GoogleAccount,
  LabelInfo,
  SavedArticle,
  SecretName,
  SecretsPresence,
  ServiceHealth,
  TaskStatus,
  UserProfile,
  VoiceState
} from './types'

/**
 * Renderer -> main request/response. This type is the only contract; the preload wrapper
 * and the main-process registrar are both derived from it, so a channel cannot exist on
 * one side without the other.
 */
export type IpcContract = {
  'voice:wake': { args: []; ret: void }
  'voice:sleep': { args: []; ret: void }
  'voice:stop': { args: []; ret: void }
  'voice:sendText': { args: [text: string]; ret: void }
  'voice:audioChunk': { args: [pcm: ArrayBuffer]; ret: void }
  /** Renderer-side VAD gate result, so we only bill Gemini for actual speech. */
  'voice:speechActivity': { args: [speaking: boolean]; ret: void }
  'voice:getState': { args: []; ret: VoiceState }
  'voice:getCost': { args: []; ret: CostEstimate }
  /**
   * The microphone failed to open. Only the renderer can find this out, and only main can say it
   * aloud — and it must be said, because a user waiting to be heard has no other way to learn
   * that nothing is listening. Playback is unaffected by a capture failure, so IRIS can speak it.
   */
  'voice:micProblem': { args: [message: string]; ret: void }

  'email:start': { args: []; ret: void }
  'email:choose': { args: [utterance: string]; ret: void }
  'email:undoLast': { args: []; ret: { ok: boolean; description: string } }
  'email:getSnapshot': { args: []; ret: EmailModeSnapshot }
  'email:listLabels': { args: []; ret: LabelInfo[] }

  'reading:list': { args: []; ret: SavedArticle[] }
  'reading:remove': { args: [id: string]; ret: void }

  'auth:googleConnect': { args: []; ret: GoogleAccount }
  'auth:googleDisconnect': { args: []; ret: void }
  'auth:googleStatus': { args: []; ret: GoogleAccount | null }

  'profile:get': { args: []; ret: UserProfile }
  'profile:set': { args: [patch: Partial<UserProfile>]; ret: void }

  'keys:set': { args: [name: SecretName, value: string]; ret: void }
  'keys:clear': { args: [name: SecretName]; ret: void }
  'keys:presence': { args: []; ret: SecretsPresence }

  'chat:history': { args: []; ret: ChatMessage[] }
  'health:get': { args: []; ret: ServiceHealth }

  'onboarding:start': { args: []; ret: void }

  'update:check': { args: []; ret: { available: boolean; version: string | null } }
  'update:applyNow': { args: []; ret: void }

  'shell:openExternal': { args: [url: string]; ret: void }

  /**
   * Opens IRIS's own browser in a visible window so a helper can sign into subscriber sites.
   * Optional start URL; defaults to Morningstar.
   */
  'browse:signIn': { args: [url?: string]; ret: void }
}

/** Main -> renderer push events. */
export type IpcEvents = {
  'voice:state': VoiceState
  'voice:audioOut': { generation: number; pcm: ArrayBuffer }
  /** Barge-in: drop queued playback for any generation below this one. */
  'voice:flush': { generation: number }
  'voice:cost': CostEstimate
  'chat:message': ChatMessage
  'chat:delta': { id: string; text: string }
  'task:update': TaskStatus | null
  'email:snapshot': EmailModeSnapshot
  'profile:changed': UserProfile
  'health:changed': ServiceHealth
  'auth:changed': GoogleAccount | null
  'keys:changed': SecretsPresence
  'reading:changed': SavedArticle[]
  /** Tells the capture worklet to keep sending frames while asleep, for wake word detection. */
  'wake:listening': boolean
  /**
   * Non-fatal problems worth speaking aloud rather than logging silently. `spoken` reports
   * whether IRIS said it in its own voice; when false the renderer hands it to the screen reader
   * instead, since otherwise the message would only ever be drawn.
   */
  'notice': { severity: 'info' | 'warning' | 'error'; text: string; spoken: boolean }
}

export type IpcChannel = keyof IpcContract
export type IpcEventName = keyof IpcEvents

export const IPC_CHANNELS = [
  'voice:wake',
  'voice:sleep',
  'voice:stop',
  'voice:sendText',
  'voice:audioChunk',
  'voice:speechActivity',
  'voice:getState',
  'voice:getCost',
  'voice:micProblem',
  'email:start',
  'email:choose',
  'email:undoLast',
  'email:getSnapshot',
  'email:listLabels',
  'reading:list',
  'reading:remove',
  'auth:googleConnect',
  'auth:googleDisconnect',
  'auth:googleStatus',
  'profile:get',
  'profile:set',
  'keys:set',
  'keys:clear',
  'keys:presence',
  'chat:history',
  'health:get',
  'onboarding:start',
  'update:check',
  'update:applyNow',
  'shell:openExternal',
  'browse:signIn'
] as const satisfies readonly IpcChannel[]

export const IPC_EVENTS = [
  'voice:state',
  'voice:audioOut',
  'voice:flush',
  'voice:cost',
  'chat:message',
  'chat:delta',
  'task:update',
  'email:snapshot',
  'profile:changed',
  'health:changed',
  'auth:changed',
  'keys:changed',
  'reading:changed',
  'wake:listening',
  'notice'
] as const satisfies readonly IpcEventName[]
