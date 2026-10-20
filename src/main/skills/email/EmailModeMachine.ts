import type {
  EmailBody,
  EmailDisposition,
  EmailHeader,
  EmailLink,
  EmailModePhase,
  EmailModeSnapshot,
  SavedArticle
} from '../../../shared/types'
import { generateJsonArray, generateText } from '../../ai/text'
import { emit } from '../../ipc/register'
import { createLogger } from '../../log'
import { articleAnnouncement, articleExtractionPrompt, ARTICLE_REVIEW_COMPLETE } from '../../prompts/article-review'
import {
  emailSummaryPrompt,
  headerAnnouncement,
  postSummaryChoice
} from '../../prompts/email-summary'
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

export interface ActionOutcome {
  ok: boolean
  /** Short factual result for the model to convey; never spoken verbatim. */
  note: string
  /** When true, narrate() already queued the main speech — skip a redundant inject. */
  narrated?: boolean
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
  'saveArticle'
])

/**
 * Owns progression and every mutation. The model's role is strictly to report what the user asked
 * for and to phrase things nicely; it never decides what happens next and never calls Gmail.
 */
export class EmailModeMachine {
  private phase: EmailModePhase = 'idle'
  private queue: EmailHeader[] = []
  private position = -1
  /** What became of each message the queue has moved past, for the inbox view. */
  private dispositions: Record<string, EmailDisposition> = {}

  /**
   * How many messages the inbox holds, known from the id list before their headers arrive. The
   * queue grows towards it chunk by chunk; once loading ends it is pinned to the queue length.
   */
  private total = 0
  /** True while headers are still arriving behind the reader. */
  private loading = false
  /** Woken on every chunk and when loading ends, for a reader who has caught up with the loader. */
  private wakeReaders: Array<() => void> = []

  private currentBody: EmailBody | null = null
  private articles: ArticleCandidate[] = []
  private articleIndex = -1
  /** Digest links held after a summary until the user asks to go through the articles. */
  private pendingArticleLinks: EmailLink[] = []

  /** Running on cached headers because Gmail was unreachable. Nothing may be mutated. */
  private offline = false

  /**
   * Set while a slow action is in flight outside the phase machine (delete/move), or claimed
   * before a fire-and-forget tool returns so a second call cannot race the first await.
   */
  private inFlight = false

  /** Coalesces concurrent start() calls (voice tool + UI) onto one inbox fetch. */
  private startPromise: Promise<ActionOutcome> | null = null

  /** Bumped on stop / new beginFetch so a stale inbox fetch cannot overwrite state. */
  private startGeneration = 0

  /** Told on every phase change; the inbox window opens and closes on these. */
  private readonly phaseListeners = new Set<(phase: EmailModePhase) => void>()

  constructor(private readonly narrate: Narrator) {}

  onPhaseChange(listener: (phase: EmailModePhase) => void): () => void {
    this.phaseListeners.add(listener)
    return () => {
      this.phaseListeners.delete(listener)
    }
  }

  isActive(): boolean {
    return this.phase !== 'idle' && this.phase !== 'exhausted'
  }

  /** True while fetching the inbox, summarizing, or another slow action has been claimed. */
  isBusy(): boolean {
    return this.inFlight || this.phase === 'fetchingQueue' || this.phase === 'summarizing'
  }

  /**
   * Claim exclusive work before returning STARTING_ACK from a tool. Returns false when another
   * slow action is already running.
   */
  tryBeginWork(): boolean {
    if (this.isBusy()) return false
    this.inFlight = true
    emit('email:snapshot', this.snapshot())
    return true
  }

  endWork(): void {
    this.inFlight = false
    emit('email:snapshot', this.snapshot())
  }

  /**
   * Synchronously enter fetchingQueue so start_email_mode can return an ack before the inbox
   * fetch begins. Returns an outcome when email mode is already active and start should not run.
   */
  beginFetch(): ActionOutcome | null {
    if (this.isActive()) {
      return { ok: true, note: 'Email mode is already running. Continue where you left off.' }
    }
    this.reset()
    this.startGeneration += 1
    this.setPhase('fetchingQueue')
    return null
  }

  snapshot(): EmailModeSnapshot {
    const current = this.current()
    return {
      phase: this.phase,
      // Null rather than out-of-range once the queue is exhausted, so nothing renders "4 of 3".
      position: current ? this.position + 1 : null,
      queueLength: Math.max(this.total, this.queue.length),
      current: current ?? null,
      queue: this.queue,
      dispositions: { ...this.dispositions },
      offline: this.offline,
      articleIndex: this.articleIndex >= 0 ? this.articleIndex + 1 : null,
      articleCount: this.articles.length > 0 ? this.articles.length : null,
      canUndo: undoStack.canUndo(),
      busy: this.isBusy()
    }
  }

  /**
   * Records the outcome for the current message before the queue moves past it. "read" is only
   * noted when nothing stronger has been recorded, so a delete after a summary still says deleted.
   */
  private dispose(disposition: EmailDisposition): void {
    const header = this.current()
    if (!header) return
    if (disposition === 'read' && this.dispositions[header.id]) return
    this.dispositions[header.id] = disposition
  }

  private current(): EmailHeader | undefined {
    return this.queue[this.position]
  }

  private setPhase(phase: EmailModePhase): void {
    const changed = this.phase !== phase
    if (changed) log.info(`${this.phase} -> ${phase}`)
    this.phase = phase
    emit('email:snapshot', this.snapshot())
    if (changed) {
      for (const listener of this.phaseListeners) listener(phase)
    }
  }

  // ---------------------------------------------------------------- entry point

  async start(): Promise<ActionOutcome> {
    if (this.startPromise) return this.startPromise

    // beginFetch() may already have claimed fetchingQueue for a fire-and-forget tool return.
    if (this.phase !== 'fetchingQueue') {
      const blocked = this.beginFetch()
      if (blocked) return blocked
    }

    this.startPromise = this.runStart().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async runStart(): Promise<ActionOutcome> {
    const generation = this.startGeneration
    this.offline = false
    try {
      await this.loadInbox(generation)
    } catch (error) {
      if (generation !== this.startGeneration) {
        return { ok: false, note: 'Left email mode.' }
      }
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
      this.loading = false
      this.queue = cached.headers
      this.total = cached.headers.length
      log.info(`offline email mode with ${this.queue.length} cached headers`)
      await this.narrate(
        `You cannot reach Gmail right now, but you still have the inbox as it was ` +
          `${describeDate(new Date(cached.fetchedAt).toISOString())}. Tell them you will read ` +
          `what was there as of then, and that you cannot delete or file anything until the ` +
          `connection is back. Keep it to one sentence.`
      )
    }

    if (generation !== this.startGeneration) {
      return { ok: false, note: 'Left email mode.' }
    }

    if (this.queue.length === 0) {
      this.setPhase('exhausted')
      return { ok: true, note: 'There is no unread mail in the primary inbox. Say so briefly.' }
    }

    log.info(`queued ${this.queue.length} of ${this.total} unread messages; starting`)
    await this.readCurrentHeader(0)
    if (generation !== this.startGeneration) {
      return { ok: false, note: 'Left email mode.' }
    }
    return { ok: true, note: '', narrated: true }
  }

  /**
   * Starts the inbox fetch and returns as soon as the first headers are in — or, for an empty
   * inbox, when the fetch finishes. Loading of the remainder carries on in the background, feeding
   * the queue chunk by chunk. Rejects only if nothing at all could be fetched; a load that fails
   * part-way keeps what arrived and pins the total to it.
   */
  private async loadInbox(generation: number): Promise<void> {
    this.loading = true

    let firstChunk!: () => void
    const firstChunkArrived = new Promise<void>((resolve) => {
      firstChunk = resolve
    })

    const whole = gmail.listPrimaryUnread((loaded, total) => {
      if (generation !== this.startGeneration) return
      this.queue = loaded
      this.total = total
      firstChunk()
      this.wakeUpReaders()
      emit('email:snapshot', this.snapshot())
    })

    const finish = (): void => {
      if (generation !== this.startGeneration) return
      this.loading = false
      this.total = this.queue.length
      this.wakeUpReaders()
      emit('email:snapshot', this.snapshot())
    }

    // Background completion: either way, loading is over and anyone waiting on more can move on.
    void whole
      .then((all) => {
        if (generation !== this.startGeneration) return
        this.queue = all
        if (all.length < this.total) {
          log.warn(`only ${all.length} of ${this.total} headers loaded; reading those`)
        }
        finish()
      })
      .catch(() => finish())

    // The first chunk is what starts the reading; the whole fetch resolving first means an empty
    // inbox (or a failure, which rethrows here so the offline fallback can take over).
    await Promise.race([firstChunkArrived, whole])
  }

  private wakeUpReaders(): void {
    const waiting = this.wakeReaders
    this.wakeReaders = []
    for (const wake of waiting) wake()
  }

  /** Resolves when another chunk has landed or loading has ended, whichever comes first. */
  private moreHeaders(): Promise<void> {
    return new Promise((resolve) => this.wakeReaders.push(resolve))
  }

  stop(): ActionOutcome {
    const remaining = Math.max(0, Math.max(this.total, this.queue.length) - (this.position + 1))
    this.inFlight = false
    this.startGeneration += 1
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
    this.dispositions = {}
    this.total = 0
    this.loading = false
    this.wakeUpReaders()
    this.currentBody = null
    this.articles = []
    this.articleIndex = -1
    this.pendingArticleLinks = []
    this.offline = false
  }

  // ---------------------------------------------------------------- progression

  private async readCurrentHeader(position: number): Promise<void> {
    this.position = position
    this.currentBody = null
    this.articles = []
    this.articleIndex = -1
    this.pendingArticleLinks = []

    // The reader has caught up with the loader: more mail exists, its headers just have not
    // arrived yet. Wait for the next chunk rather than announcing the end of a full inbox.
    const generation = this.startGeneration
    while (!this.current() && this.loading) {
      this.setPhase('fetchingQueue')
      await this.moreHeaders()
      if (generation !== this.startGeneration) return
    }

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
      headerAnnouncement(header, describeDate(header.date), position + 1, this.snapshot().queueLength)
    )
    this.setPhase('awaitingHeaderChoice')
  }

  private async advance(): Promise<void> {
    await this.readCurrentHeader(this.position + 1)
  }

  // ---------------------------------------------------------------- action dispatch

  async handle(action: EmailAction, alreadyClaimed = false): Promise<ActionOutcome> {
    if (action.type === 'stop') return this.stop()

    if (!this.isActive()) {
      return {
        ok: false,
        note: 'Email mode is not running. Offer to start it.'
      }
    }

    // Inbox fetch and summarization leave IRIS mute to the tool layer; refuse overlapping work
    // so a second call cannot race the first. Stop is allowed above. alreadyClaimed is set when
    // the voice tool claimed inFlight before returning STARTING_ACK.
    if (
      this.phase === 'fetchingQueue' ||
      this.phase === 'summarizing' ||
      (!alreadyClaimed && this.inFlight)
    ) {
      return {
        ok: false,
        note: 'Still working on that. Say so briefly and wait.'
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
        return this.handleArticleAction(action.type)
      default:
        return { ok: false, note: 'That is not something I can do right now.' }
    }
  }

  private async handleNext(): Promise<ActionOutcome> {
    if (this.phase === 'articleReview') return this.handleArticleAction('skipArticle')
    // Skipping deliberately leaves the message unread, so it is still waiting next time.
    this.dispose('skipped')
    await this.advance()
    return { ok: true, note: '', narrated: true }
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

    this.dispose('deleted')
    // No spoken confirmation — the user already said to delete. A follow-up "deleted" either
    // lands after the next header or collides with a second tool call ("still working on that").
    // Advance narrates the next email; that is the only speech.
    await this.advance()
    return { ok: true, note: '', narrated: true }
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
      this.dispose('moved')
      await this.advance()
      return { ok: true, note: '', narrated: true }
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
        return { ok: true, note: '', narrated: true }
      }
    }

    await this.narrate(
      headerAnnouncement(
        header,
        describeDate(header.date),
        this.position + 1,
        this.snapshot().queueLength
      )
    )
    return { ok: true, note: '', narrated: true }
  }

  private async handleReadMore(): Promise<ActionOutcome> {
    const header = this.current()
    if (!header) return { ok: false, note: 'There is no email open to read.' }

    if (this.pendingArticleLinks.length > 0 && this.phase === 'awaitingPostSummaryChoice') {
      const links = this.pendingArticleLinks
      this.pendingArticleLinks = []
      return this.beginArticleReview(header, links)
    }

    this.setPhase('summarizing')

    let body: EmailBody
    try {
      body = await gmail.getBody(header.id)
      this.currentBody = body
      // Opening an email is the point at which it has genuinely been read.
      await gmail.markRead(header.id).catch((error) => log.warn('markRead failed', error))
      this.dispose('read')
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

    const isDigest = digest.verdict === 'digest' || (await this.confirmDigest(digest, header))
    if (isDigest && digest.articleLinks.length > 0) {
      this.pendingArticleLinks = digest.articleLinks
    }

    const closing = postSummaryChoice(this.pendingArticleLinks.length)
    await this.narrate(
      `Read this summary aloud in a natural voice, without adding anything to it: ${summary} ` +
      `When you finish the summary, ask exactly: "${closing}" Do not ask any other question.`
    )

    this.setPhase('awaitingPostSummaryChoice')
    return { ok: true, narrated: true, note: '' }
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
      await this.narrate(
        `Ask exactly: "${postSummaryChoice(0)}" Do not add any other question or options.`
      )
      return { ok: true, narrated: true, note: '' }
    }

    this.articleIndex = -1
    this.setPhase('articleReview')
    return this.nextArticle()
  }

  private async finishArticleReview(): Promise<ActionOutcome> {
    this.articles = []
    this.articleIndex = -1
    await this.narrate(
      `Say exactly once, without adding anything: "${ARTICLE_REVIEW_COMPLETE}"`
    )
    await this.advance()
    return { ok: true, note: '', narrated: true }
  }

  private async nextArticle(): Promise<ActionOutcome> {
    this.articleIndex += 1
    const article = this.articles[this.articleIndex]

    if (!article) return this.finishArticleReview()

    this.setPhase('articleReview')
    await this.narrate(
      articleAnnouncement(article.title, this.articleIndex + 1, this.articles.length)
    )
    return { ok: true, note: '', narrated: true }
  }

  private async handleArticleAction(
    type: 'saveArticle' | 'skipArticle'
  ): Promise<ActionOutcome> {
    if (this.phase !== 'articleReview') {
      if (this.phase === 'awaitingPostSummaryChoice' && this.pendingArticleLinks.length > 0) {
        const current = this.current()
        if (!current) return { ok: false, note: 'There is no email open.' }
        const links = this.pendingArticleLinks
        this.pendingArticleLinks = []
        return this.beginArticleReview(current, links)
      }
      return { ok: false, note: 'There are no articles being reviewed right now.' }
    }

    const article = this.articles[this.articleIndex]
    const header = this.current()
    if (!article || !header) return { ok: false, note: 'There is no article open.' }

    if (type === 'skipArticle') return this.nextArticle()

    saveArticle({
      title: article.title,
      href: article.href,
      sourceSender: header.fromName
    })
    await this.nextArticle()
    return { ok: true, note: '', narrated: true }
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
