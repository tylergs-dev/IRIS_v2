import type { SearchAnswer } from '../../../shared/types'
import { setHealth } from '../../health'
import { createLogger } from '../../log'
import { getSecret } from '../../storage/secrets'

const log = createLogger('tavily')

const ENDPOINT = 'https://api.tavily.com/search'
const TIMEOUT_MS = 12_000

interface TavilyResult {
  title?: string
  url?: string
  content?: string
}

interface TavilyResponse {
  answer?: string
  results?: TavilyResult[]
}

export class NoSearchKeyError extends Error {
  constructor() {
    super(
      'I do not have a search key yet, so I cannot look things up quickly. Add a Tavily key in ' +
        'Settings, or ask me to browse the web instead.'
    )
    this.name = 'NoSearchKeyError'
  }
}

/**
 * Fast enough to be an ordinary blocking tool call, unlike the browser skill. Returns a short
 * answer plus citations so IRIS can say where something came from when asked.
 */
export async function search(query: string): Promise<SearchAnswer> {
  const apiKey = await getSecret('tavilyApiKey')
  if (!apiKey) throw new NoSearchKeyError()

  setHealth('search', 'connecting')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        query,
        // Tavily's own synthesized answer is what gets spoken; the raw results are only used
        // for citations and as a fallback.
        include_answer: 'basic',
        search_depth: 'basic',
        max_results: 5
      }),
      signal: controller.signal
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      log.warn(`search failed: ${response.status} ${detail.slice(0, 200)}`)
      setHealth('search', 'offline')
      if (response.status === 401 || response.status === 403) {
        throw new Error('My search key was rejected. Please check it in Settings.')
      }
      throw new Error('The search service did not answer just now.')
    }

    const data = (await response.json()) as TavilyResponse
    setHealth('search', 'online')

    const citations = (data.results ?? [])
      .filter((result) => result.url && result.title)
      .slice(0, 3)
      .map((result) => ({ title: result.title!, url: result.url! }))

    const answer =
      data.answer?.trim() ||
      (data.results ?? [])
        .map((result) => result.content?.trim())
        .filter(Boolean)
        .slice(0, 2)
        .join(' ') ||
      ''

    if (!answer) throw new Error('I could not find anything useful on that.')
    return { answer, citations }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      setHealth('search', 'offline')
      throw new Error('The search took too long, so I stopped waiting.')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
