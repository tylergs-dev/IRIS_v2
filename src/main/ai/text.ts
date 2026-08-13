import { GoogleGenAI } from '@google/genai'
import { createLogger } from '../log'
import { getSecret } from '../storage/secrets'

const log = createLogger('text-model')

/**
 * Summarization and classification run as ordinary generateContent calls rather than through the
 * Live session. The Live model is billed on re-processed audio context every turn, so pushing a
 * 12 KB newsletter through it would be both slow and expensive.
 *
 * There is no `gemini-3.1-flash` on generateContent — that id 404s. The 3.1 Flash text model is
 * `gemini-3.1-flash-lite`; the Live sibling stays `gemini-3.1-flash-live-preview`.
 */
export const TEXT_MODEL = 'gemini-3.1-flash-lite'

/** 429 and 503 are Google saying "try again in a moment", not a bad prompt. */
const RETRYABLE_STATUS = new Set([429, 503])
const MAX_ATTEMPTS = 3
const RETRY_BASE_MS = 700

let client: GoogleGenAI | null = null

export class NoApiKeyError extends Error {
  constructor() {
    super('I do not have a Gemini API key yet, so I cannot read or summarize anything.')
    this.name = 'NoApiKeyError'
  }
}

async function getClient(): Promise<GoogleGenAI> {
  if (client) return client
  const apiKey = await getSecret('geminiApiKey')
  if (!apiKey) throw new NoApiKeyError()
  client = new GoogleGenAI({ apiKey })
  return client
}

/** Invalidated when the key changes so a corrected key takes effect without a restart. */
export function resetTextClient(): void {
  client = null
}

export async function generateText(prompt: string): Promise<string> {
  const ai = await getClient()
  let lastError: unknown

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await ai.models.generateContent({
        model: TEXT_MODEL,
        contents: prompt,
        config: { temperature: 0.2 }
      })
      const text = response.text?.trim()
      if (!text) throw new Error('The model returned nothing.')
      return text
    } catch (error) {
      lastError = error
      const status = statusOf(error)
      if (!RETRYABLE_STATUS.has(status) || attempt === MAX_ATTEMPTS) throw error
      const delay = RETRY_BASE_MS * 2 ** (attempt - 1)
      log.warn(`text model ${status}, retrying in ${delay}ms (attempt ${attempt})`)
      await sleep(delay)
    }
  }

  throw lastError
}

function statusOf(error: unknown): number {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: unknown }).status
    if (typeof status === 'number') return status
  }
  return 0
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Parses a JSON array out of a model response, tolerating the code fences and preamble that
 * models add despite being told not to.
 */
export async function generateJsonArray<T>(prompt: string): Promise<T[]> {
  const raw = await generateText(prompt)
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end <= start) {
    log.warn('expected a JSON array but got prose', raw.slice(0, 200))
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1))
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch (error) {
    log.warn('could not parse model JSON', error)
    return []
  }
}
