import { gmail as gmailApi, type gmail_v1 } from '@googleapis/gmail'
import type { OAuth2Client } from 'google-auth-library'
import type { EmailBody, EmailHeader, GoogleAccount, LabelInfo } from '../../../shared/types'
import { createOAuthClient, runGoogleAuthFlow } from '../../auth/google-oauth'
import { setHealth } from '../../health'
import { emit } from '../../ipc/register'
import { createLogger } from '../../log'
import { getProfile, setProfile } from '../../storage/profile'
import { clearSecret, getSecret } from '../../storage/secrets'
import { cacheHeaders, clearCachedHeaders } from './header-cache'
import { extractBody, toHeader } from './parse'

const log = createLogger('gmail')

/**
 * Tabs that are not Primary. A message is in Primary when it is in the inbox and carries none of
 * these — including mail with no CATEGORY_* label at all. Search operators for this have returned
 * empty on real accounts while the INBOX label still had hundreds of unread, so Primary is decided
 * by reading each message's labelIds rather than by `q`.
 */
const OTHER_TAB_LABELS = [
  'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS'
] as const

/** Fast attempts before the label scan. Either can be empty even when Primary is not. */
const PRIMARY_SEARCH_QUERIES = [
  'in:inbox is:unread category:primary',
  'in:inbox is:unread -category:social -category:promotions -category:updates -category:forums'
] as const

/** The largest page `messages.list` will return. */
const LIST_PAGE_SIZE = 500

/**
 * Not a product cap: the queue is meant to hold the whole inbox. This only stops a mailbox with
 * thousands of unread messages from loading for minutes on end.
 */
const MAX_UNREAD = 2000

/**
 * Header loading is paced against Gmail's per-user quota of 250 units per second, where a
 * `messages.get` costs 5. Eight gets a second is 40 units — a sixth of the budget, leaving room
 * for the rest of the app and for a second IRIS on the same account. Chunks are what the reader
 * sees arrive: the first one is enough to start on; the rest load while the user is listening.
 */
const GET_INTERVAL_MS = 125
const METADATA_CONCURRENCY = 3
const HEADER_CHUNK = 20

/** Called as each chunk of headers lands. `loaded` is the whole list so far, in inbox order. */
export type HeaderProgress = (loaded: EmailHeader[], total: number) => void

/** Two quota units per call, so once a minute is comfortably inside the daily budget. */
const POLL_INTERVAL_MS = 90_000

export class NotConnectedError extends Error {
  constructor() {
    super('Gmail is not connected yet. Ask me to connect Gmail and I will walk you through it.')
    this.name = 'NotConnectedError'
  }
}

export class GmailService {
  private client: OAuth2Client | null = null
  private api: gmail_v1.Gmail | null = null
  private account: GoogleAccount | null = null

  /** In-flight sign-in, shared by every caller so only one browser flow can be open. */
  private connecting: Promise<GoogleAccount> | null = null

  private labelCache: LabelInfo[] | null = null
  private historyId: string | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private newMailListener: (() => void) | null = null

  /** True when a refresh token exists, whether or not we have talked to Google yet. */
  async isConfigured(): Promise<boolean> {
    return Boolean(await getSecret('googleRefreshToken'))
  }

  getAccount(): GoogleAccount | null {
    return this.account
  }

  /**
   * Shared rather than restarted when already running. There are now two ways in — the Settings
   * button and asking out loud — and a second flow would bind another loopback listener and open a
   * second browser tab, leaving the user with two sign-in pages and no idea which one counts.
   */
  async connect(): Promise<GoogleAccount> {
    this.connecting ??= this.doConnect().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async doConnect(): Promise<GoogleAccount> {
    const result = await runGoogleAuthFlow()
    this.reset()
    this.account = { email: result.email }
    await this.ensureApi()
    emit('auth:changed', this.account)
    return this.account
  }

  async disconnect(): Promise<void> {
    const token = await getSecret('googleRefreshToken')
    if (token && this.client) {
      // Best effort: revoking server-side means the token cannot be used even if the encrypted
      // store is later recovered from a backup.
      await this.client.revokeToken(token).catch((error) => log.warn('revoke failed', error))
    }
    await clearSecret('googleRefreshToken')
    // Folder names and cached headers are both mailbox data; neither should outlive the connection.
    setProfile({ knownLabels: [] })
    clearCachedHeaders()
    this.reset()
    setHealth('gmail', 'offline')
    emit('auth:changed', null)
  }

  private reset(): void {
    this.stopPolling()
    this.client = null
    this.api = null
    this.account = null
    this.labelCache = null
    this.historyId = null
  }

  private async ensureApi(): Promise<gmail_v1.Gmail> {
    if (this.api) return this.api

    const refreshToken = await getSecret('googleRefreshToken')
    if (!refreshToken) throw new NotConnectedError()

    setHealth('gmail', 'connecting')
    const client = await createOAuthClient()
    client.setCredentials({ refresh_token: refreshToken })

    this.client = client
    this.api = gmailApi({ version: 'v1', auth: client })

    if (!this.account) {
      const profile = await this.api.users.getProfile({ userId: 'me' })
      this.account = { email: profile.data.emailAddress ?? 'your account' }
      this.historyId = profile.data.historyId ?? null
      emit('auth:changed', this.account)
    }

    setHealth('gmail', 'online')
    return this.api
  }

  /**
   * Unread mail for email mode, newest first, delivered in chunks.
   *
   * Default is the Primary tab only — inbox messages that are not in Social / Promotions /
   * Updates / Forums. That is what Gmail shows as Inbox when tabs are on. The full INBOX label
   * also holds those other tabs and can be hundreds of messages larger.
   *
   * Id listing settles the total up front. Headers then load in paced chunks via `onProgress`
   * so reading can start after the first twenty. A fetch that fails part-way keeps what arrived;
   * only a failure before the first header rejects.
   */
  async listPrimaryUnread(onProgress?: HeaderProgress): Promise<EmailHeader[]> {
    const api = await this.ensureApi()
    // Older profiles may still have the removed "auto" value; treat it as Primary.
    const rawScope = getProfile().inboxScope as string
    const scope = rawScope === 'inbox' ? 'inbox' : 'primary'

    const ids =
      scope === 'inbox'
        ? await this.listAllIds(api, { labelIds: ['INBOX', 'UNREAD'] })
        : await this.listPrimaryIds(api)

    log.info(`unread for email mode: ${ids.length} (scope ${scope})`)
    if (ids.length === 0) return []

    const headers: EmailHeader[] = []
    const fetchHeader = async (id: string): Promise<EmailHeader> => {
      await pacer.wait()
      const message = await withRateLimitRetry(() =>
        api.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date'],
          fields: 'id,threadId,snippet,payload/headers'
        })
      )
      return toHeader(message.data)
    }

    for (let start = 0; start < ids.length; start += HEADER_CHUNK) {
      const chunk = ids.slice(start, start + HEADER_CHUNK)
      try {
        headers.push(...(await mapWithConcurrency(chunk, METADATA_CONCURRENCY, fetchHeader)))
      } catch (error) {
        if (headers.length === 0) throw error
        log.error(
          `header loading stopped after ${headers.length} of ${ids.length}; reading what arrived`,
          error
        )
        break
      }
      // Kept so that "do my emails" still has an answer when the network is down later. Written
      // per chunk so an interrupted load still leaves the newest mail behind.
      cacheHeaders(headers)
      onProgress?.(headers.slice(), ids.length)
    }

    return headers
  }

  /**
   * Ids of unread Primary-tab messages. Tries Gmail search first; if search returns nothing
   * (which it has on this account while the inbox still had hundreds of unread), falls back to
   * listing every unread inbox message and dropping those filed under another tab.
   */
  private async listPrimaryIds(api: gmail_v1.Gmail): Promise<string[]> {
    for (const q of PRIMARY_SEARCH_QUERIES) {
      const ids = await this.listAllIds(api, { q })
      log.info(`primary search ${JSON.stringify(q)} -> ${ids.length}`)
      if (ids.length > 0) return ids
    }

    const personal = await this.listAllIds(api, {
      labelIds: ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL']
    })
    log.info(`primary via CATEGORY_PERSONAL label -> ${personal.length}`)

    const inboxUnread = await this.listAllIds(api, { labelIds: ['INBOX', 'UNREAD'] })
    log.info(`scanning ${inboxUnread.length} unread inbox messages for Primary tab membership`)
    if (inboxUnread.length === 0) return personal

    const primary = await this.filterPrimaryIds(api, inboxUnread)
    log.info(`primary after label filter -> ${primary.length}`)

    // Prefer the filtered list; if somehow every message was filed under another tab, keep the
    // Personal-label result rather than returning nothing when Personal had mail.
    if (primary.length > 0) return primary
    return personal
  }

  /**
   * Keeps messages that belong on the Primary tab: in the candidate set (already INBOX+UNREAD)
   * and not labelled Social / Promotions / Updates / Forums. Preserves inbox order.
   */
  private async filterPrimaryIds(api: gmail_v1.Gmail, ids: string[]): Promise<string[]> {
    const excluded = new Set<string>(OTHER_TAB_LABELS)
    const isPrimary = ids.map(() => false)
    let sampleLogged = 0
    let keptSoFar = 0

    const inspect = async (id: string, index: number): Promise<void> => {
      await pacer.wait()
      const message = await withRateLimitRetry(() =>
        api.users.messages.get({
          userId: 'me',
          id,
          format: 'minimal',
          fields: 'id,labelIds'
        })
      )
      const labels = message.data.labelIds ?? []
      if (sampleLogged < 8) {
        sampleLogged += 1
        const categories = labels.filter((label) => label.startsWith('CATEGORY_'))
        log.info(`sample ${id}: ${categories.length > 0 ? categories.join(',') : '(no category)'}`)
      }
      if (labels.some((label) => excluded.has(label))) return
      isPrimary[index] = true
      keptSoFar += 1
    }

    // Same pacing as header loads — stays inside the per-user quota. Only labelIds, not bodies.
    for (let start = 0; start < ids.length; start += HEADER_CHUNK) {
      const chunk = ids.slice(start, start + HEADER_CHUNK)
      await mapWithConcurrency(chunk, METADATA_CONCURRENCY, (id, offset) =>
        inspect(id, start + offset)
      )
      if ((start / HEADER_CHUNK) % 5 === 4 || start + HEADER_CHUNK >= ids.length) {
        log.info(
          `primary scan ${Math.min(start + HEADER_CHUNK, ids.length)}/${ids.length} (${keptSoFar} kept)`
        )
      }
    }

    return ids.filter((_, index) => isPrimary[index])
  }

  /**
   * Follows `nextPageToken` until Gmail runs out of messages or MAX_UNREAD is reached.
   * Pass either `labelIds` or a full search `q`, not both — combining them AND-filters in ways
   * that have emptied Primary results on real accounts.
   */
  private async listAllIds(
    api: gmail_v1.Gmail,
    filter: { labelIds: string[]; q?: undefined } | { q: string; labelIds?: undefined }
  ): Promise<string[]> {
    const ids: string[] = []
    let pageToken: string | undefined

    do {
      const response = await withRateLimitRetry(() =>
        api.users.messages.list({
          userId: 'me',
          ...(filter.labelIds ? { labelIds: filter.labelIds } : {}),
          ...(filter.q ? { q: filter.q } : {}),
          // Default, but stated so a later refactor cannot quietly start reading spam aloud.
          includeSpamTrash: false,
          maxResults: LIST_PAGE_SIZE,
          pageToken,
          fields: 'messages/id,nextPageToken'
        })
      )
      for (const message of response.data.messages ?? []) {
        if (message.id) ids.push(message.id)
      }
      pageToken = response.data.nextPageToken ?? undefined
    } while (pageToken && ids.length < MAX_UNREAD)

    if (ids.length > MAX_UNREAD || pageToken) {
      log.warn(`unread inbox exceeds ${MAX_UNREAD} messages; reading the newest ${MAX_UNREAD}`)
      return ids.slice(0, MAX_UNREAD)
    }
    return ids
  }

  async getBody(id: string): Promise<EmailBody> {
    const api = await this.ensureApi()
    const message = await api.users.messages.get({ userId: 'me', id, format: 'full' })
    return extractBody(message.data)
  }

  async trash(id: string): Promise<void> {
    const api = await this.ensureApi()
    // Recoverable for 30 days. `messages.delete` is irreversible and is not reachable at all,
    // because the granted scope does not include it.
    await api.users.messages.trash({ userId: 'me', id })
  }

  async untrash(id: string): Promise<void> {
    const api = await this.ensureApi()
    await api.users.messages.untrash({ userId: 'me', id })
  }

  async markRead(id: string): Promise<void> {
    const api = await this.ensureApi()
    await api.users.messages.modify({
      userId: 'me',
      id,
      requestBody: { removeLabelIds: ['UNREAD'] }
    })
  }

  async modifyLabels(
    id: string,
    add: string[] = [],
    remove: string[] = []
  ): Promise<void> {
    const api = await this.ensureApi()
    await api.users.messages.modify({
      userId: 'me',
      id,
      requestBody: { addLabelIds: add, removeLabelIds: remove }
    })
  }

  /** Cached for the process lifetime: `addLabelIds` rejects display names, only IDs. */
  async listLabels(): Promise<LabelInfo[]> {
    if (this.labelCache) return this.labelCache
    const api = await this.ensureApi()
    const response = await api.users.labels.list({ userId: 'me' })
    this.labelCache = (response.data.labels ?? [])
      .filter((label) => label.id && label.name && label.type === 'user')
      .map((label) => ({ id: label.id!, name: label.name! }))
    this.rememberLabelNames()
    return this.labelCache
  }

  /**
   * Mirrored into the profile so the persona prompt can name the user's folders. Without this the
   * model has to spend a tool call before it can act on "move it to receipts".
   */
  private rememberLabelNames(): void {
    const names = (this.labelCache ?? []).map((label) => label.name)
    const known = getProfile().knownLabels
    if (names.length === known.length && names.every((name, i) => name === known[i])) return
    setProfile({ knownLabels: names })
  }

  /**
   * Resolves a spoken label name to an ID, tolerating case and minor wording differences, and
   * creating the label when there is no reasonable match.
   */
  async resolveLabel(spoken: string): Promise<LabelInfo> {
    const wanted = spoken.trim().toLowerCase()
    const labels = await this.listLabels()

    const exact = labels.find((label) => label.name.toLowerCase() === wanted)
    if (exact) return exact

    const partial = labels.find(
      (label) =>
        label.name.toLowerCase().includes(wanted) || wanted.includes(label.name.toLowerCase())
    )
    if (partial) return partial

    const api = await this.ensureApi()
    const created = await api.users.labels.create({
      userId: 'me',
      requestBody: { name: spoken.trim(), labelListVisibility: 'labelShow' }
    })
    const label = { id: created.data.id!, name: created.data.name! }
    this.labelCache = [...(this.labelCache ?? []), label]
    this.rememberLabelNames()
    return label
  }

  // ---------------------------------------------------------------- new mail polling

  /**
   * Polls `history.list` rather than using Pub/Sub push, which would need a public HTTPS webhook
   * this app has no way to host.
   */
  onNewMail(listener: () => void): void {
    this.newMailListener = listener
  }

  startPolling(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS)
  }

  stopPolling(): void {
    if (!this.pollTimer) return
    clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private async poll(): Promise<void> {
    try {
      const api = await this.ensureApi()
      if (!this.historyId) {
        const profile = await api.users.getProfile({ userId: 'me' })
        this.historyId = profile.data.historyId ?? null
        return
      }

      const response = await api.users.history.list({
        userId: 'me',
        startHistoryId: this.historyId,
        historyTypes: ['messageAdded'],
        labelId: 'INBOX'
      })

      this.historyId = response.data.historyId ?? this.historyId
      if ((response.data.history ?? []).length > 0) this.newMailListener?.()
    } catch (error) {
      // A 404 means the cursor aged out, which is routine — the app will have been closed
      // overnight. Re-baseline instead of treating it as a failure.
      if (isNotFound(error)) {
        log.info('history cursor expired; re-baselining')
        this.historyId = null
        return
      }
      log.warn('history poll failed', error)
      setHealth('gmail', 'connecting')
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 404
}

/** 429, or the 403 flavour Gmail uses for per-user rate limiting. */
function isRateLimited(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { code, message } = error as { code?: number; message?: string }
  if (code === 429) return true
  return code === 403 && /rate ?limit|quota/i.test(message ?? '')
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Spaces request starts so the whole process stays under Gmail's per-user quota, however many
 * callers are in flight. When Gmail pushes back anyway, `hold` parks every waiter at once —
 * one 403 should slow the whole fetch down, not just the request that happened to receive it.
 */
class Pacer {
  private nextStart = 0

  constructor(private readonly intervalMs: number) {}

  async wait(): Promise<void> {
    const now = Date.now()
    const start = Math.max(now, this.nextStart)
    this.nextStart = start + this.intervalMs
    if (start > now) await sleep(start - now)
  }

  hold(ms: number): void {
    this.nextStart = Math.max(this.nextStart, Date.now() + ms)
  }
}

const pacer = new Pacer(GET_INTERVAL_MS)

/**
 * Retries a Gmail call with backoff when the rate limit bites. The limit is per minute, so the
 * waits are long enough to actually let the window roll over rather than hammering straight
 * back into it. Anything other than a rate limit is rethrown as-is.
 */
async function withRateLimitRetry<T>(call: () => Promise<T>, attempts = 6): Promise<T> {
  let delay = 2_000
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call()
    } catch (error) {
      if (!isRateLimited(error) || attempt >= attempts) throw error
      log.warn(`rate limited; pausing ${delay}ms (attempt ${attempt} of ${attempts})`)
      pacer.hold(delay)
      await sleep(delay)
      delay = Math.min(delay * 2, 30_000)
    }
  }
}

/** `Promise.all` with at most `limit` tasks running at once, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await fn(items[index], index)
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

export const gmail = new GmailService()
