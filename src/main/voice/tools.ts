import { Type, type FunctionDeclaration } from '@google/genai'
import type { CostEstimate } from '../../shared/types'
import { getHealth } from '../health'
import { createLogger } from '../log'
import { secretsPresence } from '../storage/secrets'

const log = createLogger('tools')

export interface ToolDefinition {
  declaration: FunctionDeclaration
  /**
   * Must resolve fast. Gemini 3.1 Live has no non-blocking function calling, so the model
   * cannot speak until this returns — anything slow has to start work in the background and
   * report progress through the context channel instead.
   */
  handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

const tools = new Map<string, ToolDefinition>()

export function registerTool(definition: ToolDefinition): void {
  const name = definition.declaration.name
  if (!name) throw new Error('Tool declaration requires a name')
  tools.set(name, definition)
}

export function toolDeclarations(): FunctionDeclaration[] {
  return [...tools.values()].map((tool) => tool.declaration)
}

export async function invokeTool(
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const tool = tools.get(name)
  if (!tool) {
    log.warn(`model called unknown tool ${name}`)
    return { error: `No such capability: ${name}` }
  }
  try {
    log.info(`tool ${name}`, args)
    return await tool.handler(args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error(`tool ${name} failed`, error)
    // Returned rather than thrown so the model can explain the failure out loud.
    return { error: message }
  }
}

export const STRING = { type: Type.STRING } as const

/** Registered here rather than in a skill because sleeping is core voice behaviour. */
export function registerCoreTools(actions: {
  sleep: () => void
  cost: () => CostEstimate
}): void {
  registerTool({
    declaration: {
      name: 'go_to_sleep',
      description:
        'Stop listening and go to sleep. Call this when the user says goodbye, says to go to ' +
        'sleep, or says they are done for now.'
    },
    handler: async () => {
      // Deferred so the confirmation is spoken before the microphone stops.
      setTimeout(() => actions.sleep(), 2500)
      return { ok: true, note: 'Say a short goodbye now, then you will go quiet.' }
    }
  })

  // The running total is shown in the corner of the window, which is no use to someone who cannot
  // see it. Anyone paying per token deserves to be able to just ask.
  registerTool({
    declaration: {
      name: 'session_cost',
      description:
        'How long this conversation has been going and roughly what it has cost so far. Call this ' +
        'when the user asks about cost, spending, usage, or how long you have been talking.'
    },
    handler: async () => {
      const cost = actions.cost()
      if (cost.sessionSeconds === 0) {
        return { note: 'Nothing yet — tell them this conversation has only just started.' }
      }
      return {
        minutes: Math.max(1, Math.round(cost.sessionSeconds / 60)),
        estimatedUsd: cost.estimatedUsd.toFixed(2),
        note:
          'Round the money to cents and say it plainly, like "about four cents so far". Say it is ' +
          'an estimate. Do not read out token counts.'
      }
    }
  })

  registerTool({
    declaration: {
      name: 'describe_what_is_working',
      description:
        'What you can and cannot do at this moment, and why. Call this when the user asks what ' +
        'you can do, why something is unavailable, or whether something is set up yet.'
    },
    handler: async () => {
      const health = getHealth()
      const keys = await secretsPresence()
      const working: string[] = ['talking with them']
      const unavailable: string[] = []

      // Phrased as what to say rather than as status fields, because the answer has to come out as
      // a sentence about what they can do next, not as a read-out of a status panel.
      if (health.gmail === 'online') working.push('reading and sorting their email')
      else unavailable.push('email, because their Gmail account is not connected yet')

      if (keys.tavilyApiKey) working.push('looking things up on the web')
      else unavailable.push('quick web search, because it needs a Tavily key in Settings')

      if (health.browser !== 'offline') working.push('browsing websites')
      if (health.wakeWord === 'online') working.push('waking up when they say "hey IRIS"')
      else {
        unavailable.push(
          'waking to "hey IRIS" — they can press Control Shift I instead, which always works'
        )
      }

      return {
        working,
        unavailable,
        note:
          'Answer in one or two sentences. Lead with what they can do right now. Only mention ' +
          'what is missing if it is relevant to what they asked, and say how to fix it rather ' +
          'than only that it is broken.'
      }
    }
  })
}
