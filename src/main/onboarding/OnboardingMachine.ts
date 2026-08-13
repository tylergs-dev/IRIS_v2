import {
  ONBOARDING_TOPICS,
  type OnboardingTopic,
  type SpeechPace,
  type SummaryLength,
  type UserProfile
} from '../../shared/types'
import { createLogger } from '../log'
import { getProfile, setProfile } from '../storage/profile'
import { voice } from '../voice/VoiceSessionManager'

const log = createLogger('onboarding')

/**
 * What IRIS should ask, phrased as a cue rather than a script. Handing the Live model a verbatim
 * line makes it sound like a form being read out; handing it the intent lets it ask naturally and
 * react to whatever the user says back.
 */
const CUES: Record<OnboardingTopic, string> = {
  name: 'Ask what they would like you to call them. Just the name they prefer, nothing formal.',
  location:
    'Ask what city and state they are in, and say it is so you can answer questions about ' +
    'weather and local things without asking every time.',
  pace:
    'Ask whether this speaking pace suits them, or whether they would like you slower or ' +
    'quicker. Their answer is about your own speaking speed.',
  summary:
    'Ask whether, when you summarize an email, they would rather have the short version or a ' +
    'bit more detail. Mention they can always ask for more on any single email.',
  digests:
    'You already go through articles from a few known newsletters — Morningstar, TheStreet, ' +
    'Kiplinger, Arizona News, Consumer Reports, and Vida Lifestyles. Ask whether they also want ' +
    'you to watch for other newsletters and offer to go through those articles one at a time.'
}

/**
 * A separate state machine from Email Mode but the same shape, and for the same reason: a blind
 * user cannot see how far through a form they are, so progress has to be durable. Every answer is
 * written to disk as it arrives, so quitting halfway costs nothing.
 */
class OnboardingMachine {
  private active = false

  isActive(): boolean {
    return this.active
  }

  isNeeded(): boolean {
    return !getProfile().onboarded
  }

  /** The first topic not yet dealt with, or null when there is nothing left to ask. */
  private nextTopic(): OnboardingTopic | null {
    const done = new Set(getProfile().onboardingDone)
    return ONBOARDING_TOPICS.find((topic) => !done.has(topic)) ?? null
  }

  async start(): Promise<void> {
    const profile = getProfile()
    if (profile.onboarded) return
    // Setup abandoned earlier in this same run leaves `active` set; asking for it again from
    // Settings must not be a no-op.
    if (this.active && profile.onboardingDone.length > 0) return

    this.active = true
    // Nobody wants to be asked their own time zone; the OS already knows it.
    if (!profile.timezone) {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (timezone) setProfile({ timezone })
    }

    const resuming = profile.onboardingDone.length > 0
    log.info(resuming ? 'resuming setup' : 'starting setup')

    await voice.inject(
      'onboarding',
      resuming
        ? 'You are picking up a short setup you started with them earlier. Welcome them back in ' +
            'one sentence, say you only have a couple of questions left, then ask the next one. ' +
            `Next question: ${CUES[this.nextTopic() ?? 'name']}`
        : 'This is the very first time this person has used you, and they have not heard your ' +
            'voice before. Introduce yourself in two short sentences: your name is IRIS, you ' +
            'listen and talk, and there are four or five quick questions so you can get out of ' +
            'their way. Tell them they can say "skip that" to any question. Then ask the first ' +
            `one. First question: ${CUES.name}`
    )
  }

  /**
   * Called by the model as it learns things. Several fields can arrive at once because people
   * answer more than they were asked — "I'm Tyler, over in Denver" is one turn, not two.
   */
  async record(patch: Partial<UserProfile>, topics: OnboardingTopic[]): Promise<string> {
    const done = new Set(getProfile().onboardingDone)
    for (const topic of topics) done.add(topic)
    setProfile({ ...patch, onboardingDone: [...done] })
    log.info(`recorded ${topics.join(', ')}`)
    return this.continue()
  }

  /** "Skip that" is a valid answer and must not loop back to the same question. */
  async skip(): Promise<string> {
    const topic = this.nextTopic()
    if (!topic) return this.continue()
    const done = new Set(getProfile().onboardingDone)
    done.add(topic)
    setProfile({ onboardingDone: [...done] })
    log.info(`skipped ${topic}`)
    return this.continue()
  }

  private continue(): string {
    const topic = this.nextTopic()
    if (topic) {
      return `Acknowledge that in a few words, then ask the next question. ${CUES[topic]}`
    }
    return this.finish()
  }

  private finish(): string {
    setProfile({ onboarded: true })
    this.active = false
    log.info('setup complete')

    const name = getProfile().preferredName?.trim()
    return [
      'That was the last question, so setup is finished.',
      name ? `Thank them by name, ${name}, in a few words.` : 'Thank them in a few words.',
      'Then tell them, in two or three short sentences, what they can ask for now: going',
      'through their email one message at a time, looking something up on the web, or reading a',
      'page or article aloud. Say that anything they just told you can be changed by simply',
      'saying so, and that they can tell you more about themselves whenever they like — their',
      'interests, who matters most in their inbox, or how their days usually go.',
      'Then stop talking and wait.'
    ].join(' ')
  }

  /** Used when the user abandons setup mid-way; progress is already on disk. */
  pause(): void {
    this.active = false
  }
}

export const onboarding = new OnboardingMachine()

/**
 * The model is asked for one of a fixed set of words but does not always oblige, so both of these
 * accept whatever it sends and fall back to null rather than storing something meaningless.
 */
export function paceFromSpoken(value: unknown): SpeechPace | null {
  const text = typeof value === 'string' ? value.toLowerCase() : ''
  if (/slow|unhurried/.test(text)) return 'slow'
  if (/fast|quick|brisk/.test(text)) return 'fast'
  if (/normal|fine|good|same|this/.test(text)) return 'normal'
  return null
}

export function summaryFromSpoken(value: unknown): SummaryLength | null {
  const text = typeof value === 'string' ? value.toLowerCase() : ''
  if (/detail|long|more|full|thorough/.test(text)) return 'detailed'
  if (/short|brief|quick|concise|less/.test(text)) return 'short'
  return null
}
