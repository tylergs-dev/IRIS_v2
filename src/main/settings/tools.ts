import { Type } from '@google/genai'
import type { SpeechPace, SummaryLength } from '../../shared/types'
import { LIVE_VOICES, VOICE_NAMES, describeVoice, isVoiceName } from '../../shared/voices'
import { createLogger } from '../log'
import { gmail } from '../skills/email/GmailService'
import { browser } from '../skills/browse/BrowserService'
import { runStartEmailMode } from '../skills/SkillOrchestrator'
import { startTask } from '../skills/tasks'
import { getProfile, setProfile } from '../storage/profile'
import { secretsPresence } from '../storage/secrets'
import { registerTool } from '../voice/tools'

const log = createLogger('settings')

/**
 * The spoken half of the Settings screen.
 *
 * Everything reachable by clicking has to be reachable by asking, because the daily user cannot
 * click. These exist because an audit of the window found actions that had no spoken equivalent
 * at all — most seriously connecting Gmail.
 *
 * The two API keys, and Google's OAuth consent screens, are helper work. They cannot be dictated
 * reliably, IRIS will not read a credential aloud in a room, and the consent page needs sight.
 */
export function registerSettingsTools(): void {
  registerTool({
    declaration: {
      name: 'connect_gmail',
      description:
        'Open Google sign-in so the user can link their Gmail account. Call this only when they ' +
        'explicitly ask to connect, set up, sign in, or link Gmail. Do not call this when they ' +
        'ask to do, check, read, or go through their emails — that is start_email_mode, even if ' +
        'you are unsure whether Gmail is connected.'
    },
    handler: async () => {
      // The OAuth client credentials, not a saved sign-in: without them there is nothing to open a
      // browser for, and the failure would otherwise happen after the browser was already up.
      const keys = await secretsPresence()
      if (!keys.googleClientId || !keys.googleClientSecret) {
        return {
          error:
            'Their Google sign-in details are not set up yet. Tell them this part has to be typed ' +
            'in on the Settings screen — it needs an OAuth client ID and secret from Google Cloud ' +
            '— and that whoever helped install IRIS can do it. Do not try to read the values out.'
        }
      }

      // "Let's do emails" often lands here instead of start_email_mode. If they are already signed
      // in, they wanted to go through the inbox, not to hear that Gmail is connected.
      if (gmail.getAccount()) {
        return runStartEmailMode()
      }

      // Deliberately not awaited: the browser flow can take a minute or more, and Gemini 3.1 has
      // no non-blocking function calling, so awaiting here would leave IRIS mute throughout the
      // one part of setup where the user most needs to be told what is happening. The outcome is
      // narrated instead, because otherwise they would be left in a browser with no idea whether
      // signing in had worked.
      const task = startTask('onboarding', 'system', 'Connecting Gmail')
      void gmail.connect().then(
        (account) => task.finish(`Their Gmail account ${account.email} is now connected.`),
        (error: unknown) => {
          log.warn('spoken Gmail connect failed', error)
          const detail = error instanceof Error ? error.message : String(error)
          return task.fail(
            `Connecting their Gmail did not work: ${detail} Tell them plainly and offer to try again.`
          )
        }
      )

      return {
        started: true,
        note:
          'Tell them their web browser is opening for Google sign-in. This part needs whoever ' +
          'helped install IRIS — Google shows a "has not verified this app" warning once, and they ' +
          'should choose Advanced and continue. Say you will confirm when it is done, then wait ' +
          'quietly.'
      }
    }
  })

  registerTool({
    declaration: {
      name: 'sign_into_websites',
      description:
        'Open a real browser window so a helper can sign into subscription sites such as ' +
        'Morningstar or Kiplinger. IRIS’s browser is separate from the user’s, so those sites ' +
        'are unsigned-in until this is done. Call this when they ask to sign into a website, ' +
        'log into Morningstar, or when a page needed a subscription. Do not call this for Gmail ' +
        '— that is connect_gmail. This needs whoever helped install IRIS; do not try to type a ' +
        'password yourself.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          site: {
            type: Type.STRING,
            description:
              'A site name or https address to open, such as Morningstar or kiplinger.com. ' +
              'Leave blank to open Morningstar.'
          }
        }
      }
    },
    handler: async (args) => {
      const site = typeof args.site === 'string' ? args.site.trim() : ''
      const task = startTask('browse', 'browser', 'Website sign-in')
      void browser.openSignInSession(site || undefined).then(
        (host) =>
          task.finish(
            `A browser window is open at ${host}. Tell them this needs whoever helped install ` +
              'IRIS: they should sign in, then close the window. Those sign-ins are remembered. ' +
              'Then wait quietly.'
          ),
        (error: unknown) => {
          log.warn('website sign-in window failed', error)
          const detail = error instanceof Error ? error.message : String(error)
          return task.fail(
            `The sign-in window did not open: ${detail} Tell them plainly and offer to try again.`
          )
        }
      )

      return {
        started: true,
        note:
          'Tell them a browser window is opening so a helper can sign into their subscription ' +
          'sites. This is the same kind of helper step as Gmail. Say you will confirm when the ' +
          'window is ready, then wait quietly.'
      }
    }
  })

  registerTool({
    declaration: {
      name: 'disconnect_gmail',
      description:
        'Sign out of the user’s Gmail account and forget the saved sign-in. Call this only when ' +
        'they clearly ask to disconnect, sign out, or unlink their email.'
    },
    handler: async () => {
      await gmail.disconnect()
      return {
        ok: true,
        note: 'Confirm briefly, and mention they can connect again whenever they like.'
      }
    }
  })

  registerTool({
    declaration: {
      name: 'adjust_how_you_speak',
      description:
        'Change how fast you talk or how much detail you give, and keep it for future ' +
        'conversations. Call this whenever the user says you are too fast, too slow, too ' +
        'long-winded, or that they want more detail — including mid-sentence.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          pace: {
            type: Type.STRING,
            enum: ['slow', 'normal', 'fast'],
            description: 'How fast to speak.'
          },
          detail: {
            type: Type.STRING,
            enum: ['short', 'detailed'],
            description: 'How much detail to give by default.'
          }
        }
      }
    },
    handler: async (args) => {
      const pace = args.pace as SpeechPace | undefined
      const detail = args.detail as SummaryLength | undefined
      if (!pace && !detail) {
        return { error: 'Ask whether they want you to speak differently or say less.' }
      }

      // Both live in the system instruction, so they take full effect on the next session rather
      // than this turn. Saying so would be noise; adapting immediately is the better answer.
      setProfile({
        ...(pace ? { speechPace: pace } : {}),
        ...(detail ? { summaryLength: detail } : {})
      })

      return {
        ok: true,
        note:
          'Acknowledge in a few words and then simply do it from now on — speak at the new pace ' +
          'starting with this reply. Do not explain the setting or promise it for next time.'
      }
    }
  })

  registerTool({
    declaration: {
      name: 'change_your_voice',
      description:
        'Change which voice you speak in, and keep it for future conversations. Call this when ' +
        'the user asks for a different voice, a man or a woman, or something warmer, softer, ' +
        'deeper, calmer, younger, or clearer than how you sound now. If they have not named one, ' +
        'pick the option that best matches what they described rather than reading the list out. ' +
        `The available voices, each with how it sounds, are: ${voiceMenu()}.`,
      parameters: {
        type: Type.OBJECT,
        properties: {
          voice: {
            type: Type.STRING,
            enum: VOICE_NAMES,
            description: 'The name of the voice to switch to.'
          }
        },
        required: ['voice']
      }
    },
    handler: async (args) => {
      if (!isVoiceName(args.voice)) {
        return {
          error:
            'That is not one of the available voices. Ask what they would like you to sound ' +
            'like, then choose the closest match yourself.'
        }
      }

      // Applied by reopening the Live session, because the voice is fixed when a session is set
      // up. That takes a moment and clears what has been said so far, so the acknowledgement
      // here has to be the last thing said in the old voice.
      setProfile({ voiceName: args.voice })
      log.info(`voice change requested: ${args.voice}`)

      return {
        ok: true,
        note:
          `Say only "Switching now" or something equally short, then stop talking. You will ` +
          `start speaking again as ${describeVoice(args.voice)} in a moment and can ask then ` +
          'whether they like it. Do not explain what is happening or say anything else now.'
      }
    }
  })

  registerTool({
    declaration: {
      name: 'recall_what_you_know',
      description:
        'Everything remembered about the user. Call this when they ask what you know or remember ' +
        'about them, or what you have written down.'
    },
    handler: async () => {
      const profile = getProfile()
      const known = {
        name: profile.preferredName,
        location: [profile.city, profile.region].filter(Boolean).join(', ') || null,
        interests: profile.interests,
        notes: profile.notes,
        gmail: gmail.getAccount()?.email ?? null
      }
      const empty =
        !known.name && !known.location && known.interests.length === 0 && !known.notes

      return {
        ...known,
        note: empty
          ? 'Nothing much yet. Say so plainly and offer to remember whatever they would like.'
          : 'Read this back as a short, natural summary, not a list of fields. Mention they can ' +
            'ask you to forget any of it.'
      }
    }
  })

  registerTool({
    declaration: {
      name: 'forget_about_me',
      description:
        'Erase what you remember about the user. Call this when they ask you to forget something ' +
        'about them. Confirm out loud before calling it.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          everything: {
            type: Type.BOOLEAN,
            description: 'True to clear their name, location, interests, and notes together.'
          },
          topic: {
            type: Type.STRING,
            description:
              'A single interest or note to drop, in their words. Ignored when everything is true.'
          }
        }
      }
    },
    handler: async (args) => {
      if (args.everything === true) {
        setProfile({ preferredName: null, city: null, region: null, interests: [], notes: null })
        return { ok: true, note: 'Confirm it is gone, in a few words.' }
      }

      const topic = typeof args.topic === 'string' ? args.topic.trim().toLowerCase() : ''
      if (!topic) return { error: 'Ask them which thing they would like you to forget.' }

      const profile = getProfile()
      const kept = profile.interests.filter((interest) => !interest.toLowerCase().includes(topic))
      const notesMatch = profile.notes?.toLowerCase().includes(topic) ?? false

      if (kept.length === profile.interests.length && !notesMatch) {
        return {
          note: `You have nothing recorded about "${topic}". Say so briefly rather than apologising.`
        }
      }

      // Notes are one free-text field, so a match means the whole thing goes. Dropping more than
      // they asked is the safer error here — the alternative is claiming to have forgotten
      // something that is still in the profile and still shaping what IRIS says.
      setProfile({ interests: kept, ...(notesMatch ? { notes: null } : {}) })
      return { ok: true, note: 'Confirm briefly.' }
    }
  })
}

/**
 * The voice names carry no meaning on their own, so the descriptions go in the tool description
 * itself — otherwise "can you sound gentler" has nothing to match against.
 */
function voiceMenu(): string {
  return LIVE_VOICES.map((voice) => `${voice.name} (${voice.description})`).join(', ')
}
