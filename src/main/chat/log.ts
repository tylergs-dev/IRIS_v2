import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatRole } from '../../shared/types'
import { emit } from '../ipc/register'

/**
 * Today's conversation, held in memory. Voice and text turns land here identically so the
 * chat log is a single transcript rather than two parallel modes.
 */
const messages: ChatMessage[] = []
const MAX_MESSAGES = 500

export function getHistory(): ChatMessage[] {
  return messages.slice()
}

export function addMessage(role: ChatRole, text: string, streaming = false): ChatMessage {
  const message: ChatMessage = { id: randomUUID(), role, text, at: Date.now() }
  if (streaming) message.streaming = true
  messages.push(message)
  if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES)
  emit('chat:message', message)
  return message
}

/**
 * Appends to an existing message. Transcription arrives incrementally and out of order
 * relative to other server events, so the id is the only reliable join key.
 */
export function appendDelta(id: string, text: string): void {
  const message = messages.find((entry) => entry.id === id)
  if (!message) return
  message.text += text
  emit('chat:delta', { id, text })
}

export function finalizeMessage(id: string): void {
  const message = messages.find((entry) => entry.id === id)
  if (!message || !message.streaming) return
  delete message.streaming
  emit('chat:message', message)
}

export function clearHistory(): void {
  messages.length = 0
}
