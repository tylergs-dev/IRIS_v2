import { app } from 'electron'
import path from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { generateText } from '../../ai/text'
import { setHealth } from '../../health'
import { createLogger } from '../../log'
import { notice } from '../../notify'
import {
  describeSnapshotDiff,
  hostOf,
  nextActionPrompt,
  pageAnswerPrompt
} from '../../prompts/browse-narration'
import { startTask, type Task } from '../tasks'
import { EXTRACT_LOOSE_TEXT, EXTRACT_READABLE_TEXT } from './page-script'

const log = createLogger('browser')

/** Channels tried in order. Bundling Chromium would add ~356 MB for no benefit. */
const CHANNELS = process.platform === 'win32' ? ['msedge', 'chrome'] : ['chrome', 'msedge']

const MAX_STEPS = 8
const NAV_TIMEOUT_MS = 25_000
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000
/** Morningstar-class SPAs are empty at DOMContentLoaded; give the article time to appear. */
const CONTENT_WAIT_MS = 12_000
const MIN_ARTICLE_CHARS = 400

/** Homepages for the publications IRIS already treats as newsletters. */
const PUBLISHER_HOMES: Record<string, string> = {
  morningstar: 'https://www.morningstar.com/',
  kiplinger: 'https://www.kiplinger.com/',
  thestreet: 'https://www.thestreet.com/',
  'the street': 'https://www.thestreet.com/',
  'consumer reports': 'https://www.consumerreports.org/',
  consumerreports: 'https://www.consumerreports.org/'
}

const DEFAULT_SIGN_IN_URL = PUBLISHER_HOMES.morningstar

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
  /** True while a helper is signing into sites in a visible window. */
  private headed = false
  /** Set before we close the context ourselves, so we do not narrate a helper-finished sign-in. */
  private suppressCloseNotice = false

  /**
   * A separate browser process, never CDP into IRIS's own window. Process isolation between
   * untrusted web content and the process holding Gmail tokens is worth far more than the
   * memory saved by sharing.
   *
   * Cookies live in `browser-profile`, which is why a helper can sign into Morningstar once and
   * later headless reads still see the subscription. That is not the user's everyday Chrome
   * profile — Chrome will not share one, and we must not touch their browsing data.
   */
  private async getContext(opts?: { headed?: boolean }): Promise<BrowserContext> {
    const wantHeaded = opts?.headed === true
    if (this.launching) await this.launching

    if (this.context) {
      if (this.headed === wantHeaded) return this.context
      // A helper is already in the sign-in window; reuse it rather than kicking them out.
      if (this.headed && !wantHeaded) return this.context
      await this.close()
    }

    this.launching ??= this.launch(wantHeaded).finally(() => {
      this.launching = null
    })
    return this.launching
  }

  private async launch(headed: boolean): Promise<BrowserContext> {
    // A dedicated profile directory, never the user's real "User Data" — Chrome refuses to run
    // two processes against one profile, and we must not touch their browsing data.
    const profileDir = path.join(app.getPath('userData'), 'browser-profile')

    setHealth('browser', 'connecting')

    let lastError: unknown
    for (const channel of CHANNELS) {
      try {
        log.info(`launching browser channel ${channel}${headed ? ' (headed)' : ''}`)
        const context = await chromium.launchPersistentContext(profileDir, {
          channel,
          headless: !headed,
          // Headed: let the helper resize. Headless: a fixed article-sized viewport.
          viewport: headed ? null : { width: 1280, height: 900 },
          // Downloads would accumulate silently in a directory the user cannot see.
          acceptDownloads: false,
          // Subscriber sites often bounce an "automated" Chrome. The infobar is the tell.
          ignoreDefaultArgs: ['--enable-automation']
        })
        context.setDefaultTimeout(NAV_TIMEOUT_MS)
        context.on('close', () => {
          const signedIn = this.headed
          this.context = null
          this.headed = false
          if (signedIn && !this.suppressCloseNotice) {
            notice(
              'info',
              'The website sign-in window closed. I will use those sign-ins the next time I ' +
                'open an article.'
            )
          }
          this.suppressCloseNotice = false
        })
        this.context = context
        this.headed = headed
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
    if (this.headed) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.activeTasks > 0 || this.headed) return
      log.info('closing idle browser')
      void this.close()
    }, IDLE_SHUTDOWN_MS)
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.suppressCloseNotice = true
    const context = this.context
    this.context = null
    this.headed = false
    await context?.close().catch((error) => log.warn('error closing browser', error))
  }

  /**
   * Opens the same persistent profile in a visible window so a helper can sign into subscriber
   * sites. Cookies stay in `browser-profile` and are reused on later headless reads.
   */
  async openSignInSession(site?: string): Promise<string> {
    if (this.activeTasks > 0) {
      throw new Error(
        'IRIS is already using the browser. Wait until that finishes, then try again.'
      )
    }

    const url = resolveSignInUrl(site)
    const context = await this.getContext({ headed: true })
    const page = context.pages()[0] ?? (await context.newPage())
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.bringToFront()
    log.info(`sign-in window opened at ${hostOf(url)}`)
    return hostOf(url)
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
      await this.openAndSettle(page, url)

      task.step('Reading the page', 0.6)
      const text = await extractReadableText(page)
      if (text.length < MIN_ARTICLE_CHARS) {
        log.warn('almost nothing readable', {
          requested: url,
          landed: page.url(),
          chars: text.length,
          snippet: text.slice(0, 180)
        })
        await task.fail(
          `There was almost nothing readable on ${hostOf(page.url())}. It may need a subscription, ` +
            'or the page did not finish loading. Say so plainly, and offer to open a sign-in ' +
            'window so a helper can log into that site — those sign-ins are remembered for later.'
        )
        return
      }

      const answer = await generateText(pageAnswerPrompt(goal, page.url(), text))
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
      await this.openAndSettle(page, first)

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
      await this.waitForArticle(page)
      await this.dismissConsent(page)
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
    await this.dismissConsent(page)
  }

  /**
   * Newsletter links often go through a click-tracker that JS-redirects. SPAs then render the
   * article after DOMContentLoaded. Reading either interstitial as the page is why Morningstar
   * was coming back empty.
   */
  private async openAndSettle(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    if (isClickTracker(page.url())) {
      log.info(`waiting to leave click-tracker ${hostOf(page.url())}`)
      await page
        .waitForURL((next) => !isClickTracker(next.href), { timeout: NAV_TIMEOUT_MS })
        .catch(() => undefined)
    }
    await this.dismissConsent(page)
    await this.waitForArticle(page)
    await this.dismissConsent(page)
  }

  private async waitForArticle(page: Page): Promise<void> {
    const deadline = Date.now() + CONTENT_WAIT_MS
    while (Date.now() < deadline) {
      const chars = (await page.evaluate<string>(EXTRACT_LOOSE_TEXT)).length
      if (chars >= MIN_ARTICLE_CHARS) return
      await sleep(400)
    }
  }

  private async dismissConsent(page: Page): Promise<void> {
    const candidates = [
      page.locator('#onetrust-accept-btn-handler'),
      page.getByRole('button', { name: /^accept all( cookies)?$/i }),
      page.getByRole('button', { name: /^allow all$/i }),
      page.getByRole('button', { name: /^i agree$/i })
    ]
    for (const locator of candidates) {
      const visible = await locator.first().isVisible().catch(() => false)
      if (!visible) continue
      await locator.first().click({ timeout: 2_000 }).catch(() => undefined)
      await sleep(300)
      return
    }
  }
}

/** Strips chrome, navigation, and scripts so the model sees the article, not the furniture. */
async function extractReadableText(page: Page): Promise<string> {
  const strict = await page.evaluate<string>(EXTRACT_READABLE_TEXT)
  if (strict.length >= MIN_ARTICLE_CHARS) return strict
  const loose = await page.evaluate<string>(EXTRACT_LOOSE_TEXT)
  return loose.length > strict.length ? loose : strict
}

function isClickTracker(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      /\.mscomm\./i.test(parsed.hostname) ||
      /eloqua/i.test(parsed.hostname) ||
      /^\/e\/er/i.test(parsed.pathname)
    )
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function truncateTitle(goal: string): string {
  const clean = goal.replace(/\s+/g, ' ').trim()
  return clean.length > 54 ? `${clean.slice(0, 54)}…` : clean
}

/**
 * A homepage URL if they named a known publisher or pasted an https address; otherwise
 * Morningstar, which is the usual reason this window is opened.
 */
function resolveSignInUrl(input?: string): string {
  if (!input?.trim()) return DEFAULT_SIGN_IN_URL
  const trimmed = input.trim()
  if (/^https:\/\//i.test(trimmed)) return trimmed

  const key = trimmed
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
  if (PUBLISHER_HOMES[key]) return PUBLISHER_HOMES[key]

  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(trimmed)) {
    return `https://${trimmed}`
  }

  return DEFAULT_SIGN_IN_URL
}

export const browser = new BrowserService()
