import { Type } from '@google/genai'
import type { OnboardingTopic, UserProfile } from '../../shared/types'
import { getProfile, setProfile } from '../storage/profile'
import { registerTool } from '../voice/tools'
import { onboarding, paceFromSpoken, summaryFromSpoken } from './OnboardingMachine'

/**
 * One tool covering all five answers rather than one per question. People answer more than they
 * were asked, and a single call lets the model bank everything it just heard instead of choosing
 * which part to throw away.
 */
export function registerOnboardingTools(): void {
  registerTool({
    declaration: {
      name: 'save_setup_answer',
      description:
        'During first-time setup, record what the user just told you about themselves. Send only ' +
        'the fields you actually learned from their last answer. Returns what to say and ask ' +
        'next, so call this immediately after each answer rather than asking several questions ' +
        'first.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          preferred_name: {
            type: Type.STRING,
            description: 'What they want to be called. Just the name, no title.'
          },
          city: { type: Type.STRING, description: 'The city they live in.' },
          region: { type: Type.STRING, description: 'Their state, province, or region.' },
          speech_pace: {
            type: Type.STRING,
            description: 'How fast they want you to speak: slow, normal, or fast.'
          },
          summary_length: {
            type: Type.STRING,
            description: 'Preferred email summary length: short or detailed.'
          },
          auto_detect_newsletters: {
            type: Type.BOOLEAN,
            description:
              'True if they also want you to watch for newsletters beyond the known list and ' +
              'offer those articles. The known list is already handled either way.'
          }
        }
      }
    },
    handler: async (args) => {
      const patch: Partial<UserProfile> = {}
      const topics: OnboardingTopic[] = []

      const name = text(args.preferred_name)
      if (name) {
        patch.preferredName = name
        topics.push('name')
      }

      const city = text(args.city)
      const region = text(args.region)
      if (city || region) {
        if (city) patch.city = city
        if (region) patch.region = region
        topics.push('location')
      }

      const pace = paceFromSpoken(args.speech_pace)
      if (pace) {
        patch.speechPace = pace
        topics.push('pace')
      }

      const summary = summaryFromSpoken(args.summary_length)
      if (summary) {
        patch.summaryLength = summary
        topics.push('summary')
      }

      if (typeof args.auto_detect_newsletters === 'boolean') {
        patch.autoDetectDigests = args.auto_detect_newsletters
        topics.push('digests')
      }

      if (topics.length === 0) {
        return {
          note:
            'Nothing usable came through. Ask the question again in simpler words, or call ' +
            'skip_setup_question if they would rather not answer.'
        }
      }

      return { saved: topics, note: await onboarding.record(patch, topics) }
    }
  })

  registerTool({
    declaration: {
      name: 'skip_setup_question',
      description:
        'During first-time setup, move past the current question because the user declined it, ' +
        'could not answer, or asked to move on. Never ask a skipped question again.',
      parameters: { type: Type.OBJECT, properties: {} }
    },
    handler: async () => ({ note: await onboarding.skip() })
  })

  registerTool({
    declaration: {
      name: 'remember_about_user',
      description:
        'Store something the user has told you about themselves that is worth remembering for ' +
        'later conversations — an interest, a routine, a person who matters, a preference. Use ' +
        'this when they volunteer it, not by interrogating them.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          interests: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Topics or hobbies they care about.'
          },
          note: {
            type: Type.STRING,
            description: 'Anything else worth keeping, in one short sentence.'
          }
        }
      }
    },
    handler: async (args) => {
      const current = getProfile()
      const patch: Partial<UserProfile> = {}

      const incoming = Array.isArray(args.interests)
        ? args.interests.map((item) => text(item)).filter((item): item is string => Boolean(item))
        : []
      if (incoming.length > 0) {
        const merged = new Set(current.interests.map((item) => item.toLowerCase()))
        const additions = incoming.filter((item) => !merged.has(item.toLowerCase()))
        if (additions.length > 0) patch.interests = [...current.interests, ...additions]
      }

      const note = text(args.note)
      if (note) {
        // Appended rather than replaced: the second thing someone tells you does not cancel out
        // the first. Capped so the persona prompt cannot grow without bound.
        const combined = current.notes ? `${current.notes} ${note}` : note
        patch.notes = combined.length > 1200 ? combined.slice(-1200) : combined
      }

      if (Object.keys(patch).length === 0) return { note: 'Nothing new to remember.' }
      setProfile(patch)
      return {
        saved: true,
        note: 'Acknowledge in a few words that you will remember that. Do not repeat it back.'
      }
    }
  })
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
