import { app } from 'electron'
import path from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { generateText } from '../../ai/text'
import { setHealth } from '../../health'
import { createLogger } from '../../log'
import {
  describeSnapshotDiff,
  hostOf,
  nextActionPrompt,
  pageAnswerPrompt
} from '../../prompts/browse-narration'
import { startTask, type Task } from '../tasks'
import { EXTRACT_READABLE_TEXT } from './page-script'

const log = createLogger('browser')

/** Channels tried in order. Bundling Chromium would add ~356 MB for no benefit. */
const CHANNELS = process.platform === 'win32' ? ['msedge', 'chrome'] : ['chrome', 'msedge']

const MAX_STEPS = 8
const NAV_TIMEOUT_MS = 25_000
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000

interface BrowseAction {
  action: 'click' | 'type' | 'navigate' | 'read' | 'give_up'
  ref?: string
  url?: string
  text?: string
  submit?: boolean
  why?: string
}

class BrowserService {
  private context: BrowserContext | null = null
  private launching: Promise<BrowserContext> | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private activeTasks = 0

  /**
   * A separate browser process, never CDP into IRIS's own window. Process isolation between
   * untrusted web content and the process holding Gmail tokens is worth far more than the
   * memory saved by sharing.
   */
  private async getContext(): Promise<BrowserContext> {
    if (this.context) return this.context
    this.launching ??= this.launch().finally(() => {
      this.launching = null
    })
    return this.launching
  }

  private async launch(): Promise<BrowserContext> {
    // A dedicated profile directory, never the user's real "User Data" — Chrome refuses to run
    // two processes against one profile, and we must not touch their browsing data.
    const profileDir = path.join(app.getPath('userData'), 'browser-profile')

    setHealth('browser', 'connecting')

    let lastError: unknown
    for (const channel of CHANNELS) {
      try {
        log.info(`launching browser channel ${channel}`)
        const context = await chromium.launchPersistentContext(profileDir, {
          channel,
          headless: true,
          viewport: { width: 1280, height: 900 },
          // Downloads would accumulate silently in a directory the user cannot see.
          acceptDownloads: false
        })
        context.setDefaultTimeout(NAV_TIMEOUT_MS)
        context.on('close', () => {
          this.context = null
        })
        this.context = context
        setHealth('browser', 'online')
        return context
      } catch (error) {
        lastError = error
        log.warn(`channel ${channel} unavailable`, error)
      }
    }

    setHealth('browser', 'offline')
    log.error('no usable browser channel', lastError)
    throw new Error(
      'I could not start a web browser. IRIS uses Microsoft Edge or Google Chrome, so one of ' +
        'those needs to be installed.'
    )
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.activeTasks > 0) return
      log.info('closing idle browser')
      void this.close()
    }, IDLE_SHUTDOWN_MS)
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const context = this.context
    this.context = null
    await context?.close().catch((error) => log.warn('error closing browser', error))
  }

  /**
   * Fire-and-forget. Gemini 3.1 Live blocks on tool calls, so the tool returns a task id in
   * milliseconds and this runs on its own, narrating as it goes.
   */
  startBrowseTask(goal: string, startUrl?: string): string {
    const task = startTask('browse', 'browser', truncateTitle(goal))
    void this.runBrowseTask(task, goal, startUrl)
    return task.id
  }

  startReadTask(url: string, goal: string): string {
    const task = startTask('browse', 'browser', `Reading ${hostOf(url)}`)
    void this.runReadTask(task, url, goal)
    return task.id
  }

  private async runReadTask(task: Task, url: string, goal: string): Promise<void> {
    this.activeTasks += 1
    let page: Page | null = null
    try {
      task.step(`Opening ${hostOf(url)}`, 0.2)
      const context = await this.getContext()
      page = await context.newPage()
      await page.goto(url, { waitUntil: 'domcontentloaded' })

      task.step('Reading the page', 0.6)
      const text = await extractReadableText(page)
      if (text.length < 200) {
        await task.fail(
          `There was almost nothing readable on ${hostOf(url)}. It may need a subscription or ` +
            'may not have loaded. Say so plainly.'
        )
        return
      }

      const answer = await generateText(pageAnswerPrompt(goal, url, text))
      await task.finish(`Read this aloud naturally, without adding to it: ${answer}`)
    } catch (error) {
      log.error('read task failed', error)
      await task.fail(
        `I could not read ${hostOf(url)}. Tell the user briefly and offer to try something else.`
      )
    } finally {
      this.activeTasks -= 1
      await page?.close().catch(() => undefined)
      this.touchIdle()
    }
  }

  private async runBrowseTask(task: Task, goal: string, startUrl?: string): Promise<void> {
    this.activeTasks += 1
    let page: Page | null = null
    const history: string[] = []

    try {
      const context = await this.getContext()
      page = await context.newPage()

      const first = startUrl ?? `https://duckduckgo.com/?q=${encodeURIComponent(goal)}`
      task.step(`Opening ${hostOf(first)}`, 0.1)
      await page.goto(first, { waitUntil: 'domcontentloaded' })

      let previousSnapshot = ''

      for (let step = 0; step < MAX_STEPS; step += 1) {
        const snapshot = await this.snapshot(page)
        const diff = describeSnapshotDiff(previousSnapshot, snapshot)
        if (diff) task.step(`On ${hostOf(page.url())}: ${diff}`, (step + 1) / (MAX_STEPS + 1))
        previousSnapshot = snapshot

        const action = await this.decide(goal, page.url(), snapshot, history)
        log.info(`step ${step + 1}: ${action.action} ${action.ref ?? action.url ?? ''}`)

        if (action.action === 'read') {
          task.step('Reading the page', 0.85)
          const text = await extractReadableText(page)
          const answer = await generateText(pageAnswerPrompt(goal, page.url(), text))
          await task.finish(`Read this aloud naturally, without adding to it: ${answer}`)
          return
        }

        if (action.action === 'give_up') {
          await task.fail(
            `I stopped because ${action.why ?? 'I could not get any further'}. Tell the user ` +
              'plainly and offer an alternative.'
          )
          return
        }

        await this.perform(page, action)
        history.push(`${action.action} — ${action.why ?? ''}`.trim())
      }

      // Out of steps: read whatever is on screen rather than ending with nothing to say.
      const text = await extractReadableText(page)
      const answer = await generateText(pageAnswerPrompt(goal, page.url(), text))
      await task.finish(
        `This took longer than expected, so here is the best I found. Read it aloud naturally: ${answer}`
      )
    } catch (error) {
      log.error('browse task failed', error)
      await task.fail(
        'I ran into a problem using the web browser. Tell the user briefly and offer to try a ' +
          'quick search instead.'
      )
    } finally {
      this.activeTasks -= 1
      await page?.close().catch(() => undefined)
      this.touchIdle()
    }
  }

  /**
   * AI mode is the load-bearing choice: it adds `[ref=eN]` handles the model can target
   * deterministically, and the same tree reads out almost verbatim as narration.
   */
  private async snapshot(page: Page): Promise<string> {
    return page.locator('body').ariaSnapshot({ mode: 'ai', depth: 20 })
  }

  private async decide(
    goal: string,
    url: string,
    snapshot: string,
    history: string[]
  ): Promise<BrowseAction> {
    const raw = await generateText(nextActionPrompt(goal, url, snapshot, history))
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end <= start) return { action: 'read', why: 'could not decide' }
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as BrowseAction
      return parsed.action ? parsed : { action: 'read' }
    } catch {
      return { action: 'read', why: 'could not decide' }
    }
  }

  private async perform(page: Page, action: BrowseAction): Promise<void> {
    if (action.action === 'navigate') {
      if (!action.url || !/^https?:\/\//i.test(action.url)) {
        throw new Error('The model asked to navigate somewhere that is not a web address.')
      }
      await page.goto(action.url, { waitUntil: 'domcontentloaded' })
      return
    }

    if (!action.ref) throw new Error('The model did not say which element to use.')
    const locator = page.locator(`aria-ref=${action.ref}`)

    if (action.action === 'click') {
      await locator.click()
    } else if (action.action === 'type') {
      await locator.fill(action.text ?? '')
      if (action.submit) await locator.press('Enter')
    }

    // Snapshot refs are invalidated by navigation, so settle before the next snapshot rather
    // than racing a half-rendered page.
    await page.waitForLoadState('domcontentloaded').catch(() => undefined)
  }
}

/** Strips chrome, navigation, and scripts so the model sees the article, not the furniture. */
async function extractReadableText(page: Page): Promise<string> {
  return page.evaluate<string>(EXTRACT_READABLE_TEXT)
}

function truncateTitle(goal: string): string {
  const clean = goal.replace(/\s+/g, ' ').trim()
  return clean.length > 54 ? `${clean.slice(0, 54)}…` : clean
}

export const browser = new BrowserService()
