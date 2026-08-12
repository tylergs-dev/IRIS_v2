import { Type } from '@google/genai'
import { emit } from '../ipc/register'
import { createLogger } from '../log'
import { readingListAnnouncement } from '../prompts/article-review'
import { getProfile, setProfile } from '../storage/profile'
import { listArticles } from '../storage/reading-list'
import { registerTool } from '../voice/tools'
import { voice } from '../voice/VoiceSessionManager'
import { browser } from './browse/BrowserService'
import { EmailModeMachine, type ActionOutcome, type EmailAction } from './email/EmailModeMachine'
import { gmail } from './email/GmailService'
import { search } from './search/TavilyService'

const log = createLogger('skills')

export const emailMode = new EmailModeMachine((cue) => voice.inject('email', cue))

/** Keyword classifier for typed input and UI buttons, so nothing depends on the model. */
export function classifyEmailUtterance(utterance: string): EmailAction | null {
  const text = utterance.trim().toLowerCase()
  if (!text) return null

  const moveMatch = text.match(/(?:move|file|put)\s+(?:it\s+|this\s+)?(?:to|in|into)\s+(.+)/)
  if (moveMatch) return { type: 'move', label: moveMatch[1].replace(/[.!?]+$/, '').trim() }

  if (/\b(delete|trash|bin it|throw (it )?(a)?way|get rid of)\b/.test(text)) {
    return { type: 'delete' }
  }
  if (/\b(read (it )?(more|the rest|it all)?|open( it)?|tell me more|what does it say)\b/.test(text)) {
    return { type: 'readMore' }
  }
  if (/\b(save( it)?|add (it )?to (my )?reading list|keep it)\b/.test(text)) {
    return { type: 'saveArticle' }
  }
  if (/\b(next|skip|pass|move on|nothing|not interested)\b/.test(text)) return { type: 'next' }
  if (/\b(repeat|again|say that again|who|what was it)\b/.test(text)) return { type: 'repeat' }
  if (/\b(stop|quit|exit|done|that'?s enough|leave email)\b/.test(text)) return { type: 'stop' }

  return null
}

function announce(outcome: ActionOutcome): Record<string, unknown> {
  emit('email:snapshot', emailMode.snapshot())
  return outcome.ok ? { ok: true, note: outcome.note } : { ok: false, error: outcome.note }
}

export function registerEmailSkill(): void {
  registerTool({
    declaration: {
      name: 'start_email_mode',
      description:
        'Begin going through the unread mail in the primary inbox, one email at a time. Use this ' +
        'when the user asks to do their emails, check their mail, or hear what is new.'
    },
    handler: async () => announce(await emailMode.start())
  })

  registerTool({
    declaration: {
      name: 'email_action',
      description:
        'Report what the user decided about the email or article currently being read. Call this ' +
        'as soon as their intent is clear. Do not perform the action yourself and do not ask for ' +
        'confirmation before deleting — deletions are recoverable and undoable.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          action: {
            type: Type.STRING,
            enum: [
              'next',
              'delete',
              'read_more',
              'move',
              'repeat',
              'stop',
              'save_article',
              'skip_article',
              'open_article'
            ],
            description:
              'next skips to the following email and leaves it unread. delete moves it to the ' +
              'trash. read_more opens and summarizes it. move files it under a label. repeat ' +
              'reads the sender and subject again. stop leaves email mode. save_article adds the ' +
              'current article to the reading list. skip_article goes to the next article. ' +
              'open_article reads the article itself aloud.'
          },
          label: {
            type: Type.STRING,
            description: 'The folder or label name, required only when action is "move".'
          }
        },
        required: ['action']
      }
    },
    handler: async (args) => {
      const action = toEmailAction(args)
      if (!action) return { ok: false, error: 'I did not catch what to do. Ask them to repeat.' }
      return announce(await emailMode.handle(action))
    }
  })

  registerTool({
    declaration: {
      name: 'undo_last_email_action',
      description:
        'Reverse the last change made to an email — restore it from the trash or move it back to ' +
        'the inbox. Use whenever the user says to undo, or that they did not mean to do that.'
    },
    handler: async () => {
      const result = await emailMode.undoLast()
      return result.ok
        ? { ok: true, note: `Undone: ${result.description}. Confirm briefly.` }
        : { ok: false, error: result.description }
    }
  })

  registerTool({
    declaration: {
      name: 'read_my_saved_articles',
      description:
        'Read out the reading list of articles the user saved while going through newsletters.'
    },
    handler: async () => {
      const articles = listArticles()
      await voice.inject('email', readingListAnnouncement(articles))
      return { ok: true, count: articles.length }
    }
  })

  registerTool({
    declaration: {
      name: 'list_email_folders',
      description:
        'List the folders and labels available in the mailbox. Use when the user wants to file an ' +
        'email but is not sure what folders exist.'
    },
    handler: async () => {
      const labels = await gmail.listLabels()
      return labels.length > 0
        ? { folders: labels.map((label) => label.name) }
        : { folders: [], note: 'There are no custom folders in this mailbox yet.' }
    }
  })

  registerTool({
    declaration: {
      name: 'remember_newsletter_preference',
      description:
        'Record that a sender should always, or never, be treated as a newsletter whose article ' +
        'links are worth going through one by one. Use this when the user corrects you — "this ' +
        'one is always a newsletter", "stop offering me the links from her". Applies to every ' +
        'future email from that sender.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          is_newsletter: {
            type: Type.BOOLEAN,
            description: 'True to always treat this sender as a newsletter, false to never.'
          },
          sender: {
            type: Type.STRING,
            description:
              'The email address, or part of it such as the domain. Leave this out to use the ' +
              'sender of the email currently open.'
          }
        },
        required: ['is_newsletter']
      }
    },
    handler: async (args) => {
      if (typeof args.is_newsletter !== 'boolean') {
        return { error: 'Ask whether they want this sender always or never treated that way.' }
      }

      const spoken = typeof args.sender === 'string' ? args.sender.trim() : ''
      const sender = spoken || emailMode.snapshot().current?.fromAddress || ''
      if (!sender) {
        return { error: 'There is no email open, so ask which sender they mean.' }
      }

      const key = sender.toLowerCase()
      const profile = getProfile()
      // Membership is exclusive: the two lists are read in order, so leaving a stale entry in the
      // other one would silently win.
      const digestSenders = profile.digestSenders.filter((entry) => entry.toLowerCase() !== key)
      const nonDigestSenders = profile.nonDigestSenders.filter(
        (entry) => entry.toLowerCase() !== key
      )
      if (args.is_newsletter) digestSenders.push(key)
      else nonDigestSenders.push(key)
      setProfile({ digestSenders, nonDigestSenders })

      log.info(`${key} marked ${args.is_newsletter ? 'digest' : 'not digest'}`)
      return {
        saved: true,
        note: `Confirm in a few words that you will remember that about ${sender}.`
      }
    }
  })

  // New mail arriving is worth mentioning, but only when the user is already listening —
  // interrupting silence with unsolicited speech would be startling.
  gmail.onNewMail(() => {
    if (voice.getState() === 'asleep') return
    log.info('new mail detected')
    void voice.inject(
      'email',
      'New mail just arrived in the primary inbox. Mention it in one short sentence when there ' +
        'is a natural pause, and offer to go through it.'
    )
  })
}

export function registerResearchSkills(): void {
  registerTool({
    declaration: {
      name: 'search_web',
      description:
        'Look up a short factual answer on the web with sources. Use for questions like weather, ' +
        'opening hours, prices, definitions, news, or "what is". This is fast — prefer it over ' +
        'browsing whenever a short answer will do.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: { type: Type.STRING, description: 'What to search for, in plain words.' }
        },
        required: ['query']
      }
    },
    handler: async (args) => {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (!query) return { error: 'Ask them what they would like me to look up.' }
      try {
        const result = await search(query)
        return {
          answer: result.answer,
          sources: result.citations.map((citation) => citation.title),
          note: 'Summarize this in your own words. Only name a source if the user asks.'
        }
      } catch (error) {
        // Degraded mode, spoken rather than silent. Search being down does not mean the web is
        // unreachable — the browser skill can answer the same question, slower. Offering that is
        // more use than reporting a failure and stopping.
        return {
          error: error instanceof Error ? error.message : String(error),
          alternative: 'browse_web',
          note:
            'Say briefly that quick search is not working, then offer to look it up the slower ' +
            'way by browsing. If they agree, call browse_web with the same question.'
        }
      }
    }
  })

  registerTool({
    declaration: {
      name: 'browse_web',
      description:
        'Use a real web browser to work through something a single search cannot answer — ' +
        'comparing options across pages, following a multi-step flow, or checking a specific ' +
        'site. This takes a while and narrates its own progress, so say you are starting and ' +
        'then stop talking; the results will arrive on their own.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          goal: {
            type: Type.STRING,
            description: 'What the user wants to find out or accomplish, in one sentence.'
          },
          start_url: {
            type: Type.STRING,
            description: 'Optional web address to start from, when the user named a site.'
          }
        },
        required: ['goal']
      }
    },
    handler: async (args) => {
      const goal = typeof args.goal === 'string' ? args.goal.trim() : ''
      if (!goal) return { error: 'Ask what they would like me to look into.' }
      const startUrl = typeof args.start_url === 'string' ? args.start_url : undefined
      const taskId = browser.startBrowseTask(goal, startUrl)
      // Returns immediately: the model cannot speak until a tool call resolves.
      return {
        started: true,
        taskId,
        note: 'Say in one short sentence that you are looking into it, then wait quietly.'
      }
    }
  })

  registerTool({
    declaration: {
      name: 'read_web_page',
      description:
        'Open one specific web page and tell the user what it says. Use for a saved article or a ' +
        'link from an email. Narrates on its own, so say you are opening it and then wait.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          url: { type: Type.STRING, description: 'The full web address to read.' },
          question: {
            type: Type.STRING,
            description: 'What the user wants to know from it. Defaults to a general summary.'
          }
        },
        required: ['url']
      }
    },
    handler: async (args) => {
      const url = typeof args.url === 'string' ? args.url.trim() : ''
      if (!/^https?:\/\//i.test(url)) return { error: 'That does not look like a web address.' }
      const question =
        typeof args.question === 'string' && args.question.trim()
          ? args.question.trim()
          : 'What does this page say?'
      const taskId = browser.startReadTask(url, question)
      return {
        started: true,
        taskId,
        note: 'Say in one short sentence that you are opening it, then wait quietly.'
      }
    }
  })
}

function toEmailAction(args: Record<string, unknown>): EmailAction | null {
  const action = typeof args.action === 'string' ? args.action : ''
  const label = typeof args.label === 'string' ? args.label : ''

  switch (action) {
    case 'next':
      return { type: 'next' }
    case 'delete':
      return { type: 'delete' }
    case 'read_more':
      return { type: 'readMore' }
    case 'move':
      return { type: 'move', label }
    case 'repeat':
      return { type: 'repeat' }
    case 'stop':
      return { type: 'stop' }
    case 'save_article':
      return { type: 'saveArticle' }
    case 'skip_article':
      return { type: 'skipArticle' }
    case 'open_article':
      return { type: 'openArticle' }
    default:
      return null
  }
}
