import { create } from 'zustand'
import type {
  ChatMessage,
  CostEstimate,
  EmailModeSnapshot,
  GoogleAccount,
  SavedArticle,
  SecretsPresence,
  ServiceHealth,
  TaskStatus,
  UserProfile,
  VoiceState
} from '@shared/types'

export type Tab = 'chat' | 'skills' | 'settings'

export interface Notice {
  id: number
  severity: 'info' | 'warning' | 'error'
  text: string
  /** Whether IRIS said it aloud. If not, only a helper looking at the window will see it. */
  spoken: boolean
}

interface IrisStore {
  tab: Tab
  voiceState: VoiceState
  micActive: boolean
  micError: string | null
  messages: ChatMessage[]
  task: TaskStatus | null
  email: EmailModeSnapshot | null
  profile: UserProfile | null
  health: ServiceHealth
  account: GoogleAccount | null
  keys: SecretsPresence
  readingList: SavedArticle[]
  cost: CostEstimate | null
  notices: Notice[]
}

export const useStore = create<IrisStore>(() => ({
  tab: 'chat',
  voiceState: 'asleep',
  micActive: false,
  micError: null,
  messages: [],
  task: null,
  email: null,
  profile: null,
  health: {
    voice: 'offline',
    gmail: 'offline',
    search: 'offline',
    browser: 'offline',
    wakeWord: 'offline'
  },
  account: null,
  keys: {
    geminiApiKey: false,
    tavilyApiKey: false,
    googleRefreshToken: false,
    googleClientId: false,
    googleClientSecret: false
  },
  readingList: [],
  cost: null,
  notices: []
}))

export const setTab = (tab: Tab): void => useStore.setState({ tab })

let noticeId = 0

export function pushNotice(severity: Notice['severity'], text: string, spoken: boolean): void {
  const notice = { id: ++noticeId, severity, text, spoken }
  useStore.setState((state) => ({ notices: [...state.notices, notice].slice(-5) }))
}

export function dismissNotice(id: number): void {
  useStore.setState((state) => ({ notices: state.notices.filter((n) => n.id !== id) }))
}

export function upsertMessage(message: ChatMessage): void {
  useStore.setState((state) => {
    const index = state.messages.findIndex((entry) => entry.id === message.id)
    if (index === -1) return { messages: [...state.messages, message] }
    const messages = state.messages.slice()
    messages[index] = message
    return { messages }
  })
}

export function applyDelta(id: string, text: string): void {
  useStore.setState((state) => {
    const index = state.messages.findIndex((entry) => entry.id === id)
    if (index === -1) return state
    const messages = state.messages.slice()
    messages[index] = { ...messages[index], text: messages[index].text + text }
    return { messages }
  })
}
