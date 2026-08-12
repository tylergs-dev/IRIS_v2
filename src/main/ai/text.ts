import { GoogleGenAI } from '@google/genai'
import { createLogger } from '../log'
import { getSecret } from '../storage/secrets'

const log = createLogger('text-model')

/**
 * Summarization and classification run as ordinary generateContent calls rather than through the
 * Live session. The Live model is billed on re-processed audio context every turn, so pushing a
 * 12 KB newsletter through it would be both slow and expensive.
 */
export const TEXT_MODEL = 'gemini-3.1-flash'

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
  const response = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents: prompt,
    config: { temperature: 0.2 }
  })
  const text = response.text?.trim()
  if (!text) throw new Error('The model returned nothing.')
  return text
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
