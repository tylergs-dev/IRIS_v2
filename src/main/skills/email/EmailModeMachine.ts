import type {
  EmailBody,
  EmailHeader,
  EmailModePhase,
  EmailModeSnapshot,
  SavedArticle
} from '../../../shared/types'
import { generateJsonArray, generateText } from '../../ai/text'
import { emit } from '../../ipc/register'
import { createLogger } from '../../log'
import { articleAnnouncement, articleExtractionPrompt } from '../../prompts/article-review'
import { emailSummaryPrompt, headerAnnouncement } from '../../prompts/email-summary'
import { getProfile } from '../../storage/profile'
import { listArticles, saveArticle } from '../../storage/reading-list'
import { detectLinkDigest } from './digest-detect'
import { gmail, NotConnectedError } from './GmailService'
import { cachedHeaders } from './header-cache'
import { describeDate } from './parse'
import { undoStack, type UndoEntry } from './undo'

const log = createLogger('email-mode')

/** What the app tells the voice layer to say. Injected, never spoken by the machine directly. */
export type Narrator = (cue: string) => Promise<void>

export type EmailAction =
  | { type: 'next' }
  | { type: 'delete' }
  | { type: 'readMore' }
  | { type: 'move'; label: string }
  | { type: 'repeat' }
  | { type: 'stop' }
  | { type: 'saveArticle' }
  | { type: 'skipArticle' }
  | { type: 'openArticle' }

export interface ActionOutcome {
  ok: boolean
  /** Short factual result for the model to convey; never spoken verbatim. */
  note: string
}

interface ArticleCandidate {
  title: string
  href: string
}

/**
 * Everything that needs the network: either to change the mailbox, or to fetch a body to summarize.
 * Refused outright while running on cached headers.
 */
const MUTATING_ACTIONS = new Set<EmailAction['type']>([
  'delete',
  'move',
  'readMore',
  'saveArticle',
  'openArticle'
])

/**
 * Owns progression and every mutation. The model's role is strictly to report what the user asked
 * for and to phrase things nicely; it never decides what happens next and never calls Gmail.
 */
export class EmailModeMachine {
  private phase: EmailModePhase = 'idle'
  private queue: EmailHeader[] = []
  private position = -1

  private currentBody: EmailBody | null = null
  private articles: ArticleCandidate[] = []
  private articleIndex = -1

  /** Running on cached headers because Gmail was unreachable. Nothing may be mutated. */
  private offline = false

  constructor(private readonly narrate: Narrator) {}

  isActive(): boolean {
    return this.phase !== 'idle' && this.phase !== 'exhausted'
  }

  snapshot(): EmailModeSnapshot {
    const current = this.current()
    return {
      phase: this.phase,
      // Null rather than out-of-range once the queue is exhausted, so nothing renders "4 of 3".
      position: current ? this.position + 1 : null,
      queueLength: this.queue.length,
      current: current ?? null,
      articleIndex: this.articleIndex >= 0 ? this.articleIndex + 1 : null,
      articleCount: this.articles.length > 0 ? this.articles.length : null,
      canUndo: undoStack.canUndo()
    }
  }

  private current(): EmailHeader | undefined {
    return this.queue[this.position]
  }

  private setPhase(phase: EmailModePhase): void {
    if (this.phase !== phase) log.info(`${this.phase} -> ${phase}`)
    this.phase = phase
    emit('email:snapshot', this.snapshot())
  }

  // ---------------------------------------------------------------- entry point

  async start(): Promise<ActionOutcome> {
    if (this.isActive()) {
      return { ok: true, note: 'Email mode is already running. Continue where you left off.' }
    }

    this.reset()
    this.setPhase('fetchingQueue')

    this.offline = false
    try {
      this.queue = await gmail.listPrimaryUnread()
    } catch (error) {
      if (error instanceof NotConnectedError) {
        this.setPhase('idle')
        return { ok: false, note: error.message }
      }
      log.error('could not fetch the inbox', error)

      // Degraded mode rather than a dead end. "I cannot reach Gmail" answers nothing the user
      // asked; the last known headers usually do, since the real question is who wrote and about
      // what. Nothing can be changed until the network is back, which is enforced below and said
      // out loud up front rather than discovered when an action fails.
      const cached = cachedHeaders()
      if (cached.headers.length === 0 || cached.fetchedAt === null) {
        this.setPhase('idle')
        return {
          ok: false,
          note: 'I could not reach Gmail just now. Tell the user plainly and offer to try again.'
        }
      }

      this.offline = true
      this.queue = cached.headers
      log.info(`offline email mode with ${this.queue.length} cached headers`)
      await this.narrate(
        `You cannot reach Gmail right now, but you still have the inbox as it was ` +
          `${describeDate(new Date(cached.fetchedAt).toISOString())}. Tell them you will read ` +
          `what was there as of then, and that you cannot delete or file anything until the ` +
          `connection is back. Keep it to one sentence.`
      )
    }

    if (this.queue.length === 0) {
      this.setPhase('exhausted')
      return { ok: true, note: 'There is no unread mail in the primary inbox. Say so briefly.' }
    }

    log.info(`queued ${this.queue.length} unread messages`)
    await this.readCurrentHeader(0)
    return {
      ok: true,
      note: `Starting email mode with ${this.queue.length} unread messages.`
    }
  }

  stop(): ActionOutcome {
    const remaining = Math.max(0, this.queue.length - (this.position + 1))
    this.reset()
    this.setPhase('idle')
    return {
      ok: true,
      note:
        remaining > 0
          ? `Left email mode with ${remaining} still unread.`
          : 'Left email mode.'
    }
  }

  private reset(): void {
    this.queue = []
    this.position = -1
    this.currentBody = null
    this.articles = []
    this.articleIndex = -1
    this.offline = false
  }

  // ---------------------------------------------------------------- progression

  private async readCurrentHeader(position: number): Promise<void> {
    this.position = position
    this.currentBody = null
    this.articles = []
    this.articleIndex = -1

    const header = this.current()
    if (!header) {
      this.setPhase('exhausted')
      await this.narrate(
        'That was the last unread email. Tell the user they are through the inbox, briefly.'
      )
      return
    }

    this.setPhase('readingHeader')
    await this.narrate(
      headerAnnouncement(header, describeDate(header.date), position + 1, this.queue.length)
    )
    this.setPhase('awaitingHeaderChoice')
  }

  private async advance(): Promise<void> {
    await this.readCurrentHeader(this.position + 1)
  }

  // ---------------------------------------------------------------- action dispatch

  async handle(action: EmailAction): Promise<ActionOutcome> {
    if (action.type === 'stop') return this.stop()

    if (!this.isActive()) {
      return {
        ok: false,
        note: 'Email mode is not running. Offer to start it.'
      }
    }

    // Checked once here rather than in each handler, so a new action cannot be added later that
    // quietly tries to reach the network while offline.
    if (this.offline && MUTATING_ACTIONS.has(action.type)) {
      return {
        ok: false,
        note:
          'That needs Gmail, which is still unreachable. Say so briefly and offer to keep reading ' +
          'or to try again in a moment. Do not claim it worked.'
      }
    }

    switch (action.type) {
      case 'next':
        return this.handleNext()
      case 'delete':
        return this.handleDelete()
      case 'move':
        return this.handleMove(action.label)
      case 'readMore':
        return this.handleReadMore()
      case 'repeat':
        return this.handleRepeat()
      case 'saveArticle':
      case 'skipArticle':
      case 'openArticle':
        return this.handleArticleAction(action.type)
      default:
        return { ok: false, note: 'That is not something I can do right now.' }
    }
  }

  private async handleNext(): Promise<ActionOutcome> {
    if (this.phase === 'articleReview') return this.handleArticleAction('skipArticle')
    // Skipping deliberately leaves the message unread, so it is still waiting next time.
    await this.advance()
    return { ok: true, note: 'Skipped. Moving to the next email.' }
  }

  private async handleDelete(): Promise<ActionOutcome> {
    const header = this.current()
    if (!header) return { ok: false, note: 'There is no email open to delete.' }

    try {
      await gmail.trash(header.id)
    } catch (error) {
      log.error('trash failed', error)
      return { ok: false, note: 'I could not move that to the trash. Say so and offer to retry.' }
    }

    // Recorded before advancing so "undo that" refers to the email just acted on.
    undoStack.push({
      kind: 'trash',
      messageId: header.id,
      description: `moving the email from ${header.fromName} to the trash`
    })

    await this.advance()
    return {
      ok: true,
      note:
        'Moved to the trash, recoverable for thirty days. Confirm in a few words and move on. ' +
        'Do not ask for confirmation.'
    }
  }

  private async handleMove(labelName: string): Promise<ActionOutcome> {
    const header = this.current()
    if (!header) return { ok: false, note: 'There is no email open to move.' }
    if (!labelName.trim()) {
      return { ok: false, note: 'Ask which folder they want it moved to.' }
    }

    try {
      const label = await gmail.resolveLabel(labelName)
      // Display names are rejected by the API; only resolved IDs work.
      await gmail.modifyLabels(header.id, [label.id], ['INBOX', 'UNREAD'])
      undoStack.push({
        kind: 'label',
        messageId: header.id,
        addedLabelId: label.id,
        description: `moving the email from ${header.fromName} to ${label.name}`
      })
      await this.advance()
      return { ok: true, note: `Moved to ${label.name}. Confirm briefly and move on.` }
    } catch (error) {
      log.error('move failed', error)
      return { ok: false, note: 'I could not move that email. Say so and offer to try again.' }
    }
  }

  private async handleRepeat(): Promise<ActionOutcome> {
    const header = this.current()
    if (!header) return { ok: false, note: 'There is nothing to repeat.' }

    if (this.phase === 'articleReview') {
      const article = this.articles[this.articleIndex]
      if (article) {
        await this.narrate(
          articleAnnouncement(article.title, this.articleIndex + 1, this.articles.length)
        )
        return { ok: true, note: 'Repeated the article title.' }
      }
    }

    await this.narrate(
      headerAnnouncement(header, describeDate(header.date), this.position + 1, this.queue.length)
    )
    return { ok: true, note: 'Repeated the sender and subject.' }
  }

  private async handleReadMore(): Promise<ActionOutcome> {
    const header = this.current()
    if (!header) return { ok: false, note: 'There is no email open to read.' }

    this.setPhase('summarizing')

    let body: EmailBody
    try {
      body = await gmail.getBody(header.id)
      this.currentBody = body
      // Opening an email is the point at which it has genuinely been read.
      await gmail.markRead(header.id).catch((error) => log.warn('markRead failed', error))
    } catch (error) {
      log.error('could not fetch the body', error)
      this.setPhase('awaitingHeaderChoice')
      return { ok: false, note: 'I could not open that email. Say so and offer to move on.' }
    }

    const profile = getProfile()
    const digest = detectLinkDigest(header, body, profile)
    log.info(`digest verdict: ${digest.verdict} (${digest.reason})`)

    let summary: string
    try {
      summary = await generateText(emailSummaryPrompt(header, body.text, profile))
    } catch (error) {
      log.error('summarization failed', error)
      this.setPhase('awaitingPostSummaryChoice')
      return {
        ok: false,
        note: 'I could not summarize that one. Say so and offer to move to the next email.'
      }
    }

    await this.narrate(
      `Read this summary aloud in a natural voice, without adding anything to it: ${summary}`
    )

    const isDigest = digest.verdict === 'digest' || (await this.confirmDigest(digest, header))
    if (isDigest && digest.articleLinks.length > 0) {
      return this.beginArticleReview(header, digest.articleLinks)
    }

    this.setPhase('awaitingPostSummaryChoice')
    return { ok: true, note: 'Summary read. Ask what they would like to do with this email.' }
  }

  /** Only reached when the heuristic is genuinely borderline, so the model call is rare. */
  private async confirmDigest(
    digest: ReturnType<typeof detectLinkDigest>,
    header: EmailHeader
  ): Promise<boolean> {
    if (digest.verdict !== 'uncertain') return false
    try {
      const answer = await generateText(
        `An email from "${header.fromName}" with the subject "${header.subject}" contains ` +
          `${digest.articleLinks.length} links to separate pages. Is this a newsletter whose main ` +
          'purpose is to list articles for the reader to choose from? Answer with only YES or NO.'
      )
      return /^\s*yes/i.test(answer)
    } catch (error) {
      log.warn('digest confirmation failed; treating as not a digest', error)
      return false
    }
  }

  // ---------------------------------------------------------------- article review

  private async beginArticleReview(
    header: EmailHeader,
    links: ReturnType<typeof detectLinkDigest>['articleLinks']
  ): Promise<ActionOutcome> {
    let candidates: ArticleCandidate[] = []
    try {
      candidates = await generateJsonArray<ArticleCandidate>(
        articleExtractionPrompt(links, header.fromName)
      )
    } catch (error) {
      log.warn('article extraction failed; falling back to anchor text', error)
    }

    // The heuristic filter already removed the junk, so its output is a sound fallback if the
    // model call fails or returns nothing usable.
    const usable = candidates.filter((item) => item?.title && item?.href)
    this.articles =
      usable.length > 0 ? usable : links.map((link) => ({ title: link.text, href: link.href }))

    if (this.articles.length === 0) {
      this.setPhase('awaitingPostSummaryChoice')
      return { ok: true, note: 'Ask what they would like to do with this email.' }
    }

    await this.narrate(
      `This is a newsletter with ${this.articles.length} articles. Offer to go through them one ` +
        'at a time, in one short sentence.'
    )
    this.articleIndex = -1
    this.setPhase('articleReview')
    return this.nextArticle()
  }

  private async nextArticle(): Promise<ActionOutcome> {
    this.articleIndex += 1
    const article = this.articles[this.articleIndex]

    if (!article) {
      this.articles = []
      this.articleIndex = -1
      await this.advance()
      return { ok: true, note: 'That was the last article in that newsletter.' }
    }

    this.setPhase('articleReview')
    await this.narrate(
      articleAnnouncement(article.title, this.articleIndex + 1, this.articles.length)
    )
    return { ok: true, note: `Read article ${this.articleIndex + 1}.` }
  }

  private async handleArticleAction(
    type: 'saveArticle' | 'skipArticle' | 'openArticle'
  ): Promise<ActionOutcome> {
    if (this.phase !== 'articleReview') {
      return { ok: false, note: 'There are no articles being reviewed right now.' }
    }

    const article = this.articles[this.articleIndex]
    const header = this.current()
    if (!article || !header) return { ok: false, note: 'There is no article open.' }

    if (type === 'skipArticle') return this.nextArticle()

    const saved: SavedArticle = saveArticle({
      title: article.title,
      href: article.href,
      sourceSender: header.fromName
    })

    if (type === 'saveArticle') {
      const outcome = await this.nextArticle()
      return {
        ok: true,
        note: `Saved "${saved.title}" to the reading list. ${outcome.note}`
      }
    }

    // 'openArticle' hands off to the browser skill, which narrates on its own. Saving first
    // means the article is not lost if fetching the page fails.
    return {
      ok: true,
      note:
        `Saved "${saved.title}" to the reading list. Now use the read_web_page capability on ` +
        `${saved.href} to tell them what it says.`
    }
  }

  // ---------------------------------------------------------------- undo

  async undoLast(): Promise<{ ok: boolean; description: string }> {
    const entry = undoStack.peek()
    if (!entry) return { ok: false, description: 'there is nothing to undo' }

    try {
      await this.revert(entry)
    } catch (error) {
      log.error('undo failed', error)
      return { ok: false, description: `I could not undo ${entry.description}` }
    }

    undoStack.pop()
    emit('email:snapshot', this.snapshot())
    return { ok: true, description: entry.description }
  }

  private async revert(entry: UndoEntry): Promise<void> {
    if (entry.kind === 'trash') {
      await gmail.untrash(entry.messageId)
      return
    }
    // Put it back exactly as it was: remove what we added, restore INBOX and UNREAD.
    await gmail.modifyLabels(entry.messageId, ['INBOX', 'UNREAD'], [entry.addedLabelId])
  }

  savedArticles(): SavedArticle[] {
    return listArticles()
  }

  currentBodyText(): string | null {
    return this.currentBody?.text ?? null
  }
}
