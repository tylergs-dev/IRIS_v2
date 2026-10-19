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
 * Gmail's label for the Primary tab. It is CATEGORY_PERSONAL, not CATEGORY_PRIMARY; the other tabs
 * are CATEGORY_PROMOTIONS, CATEGORY_SOCIAL, CATEGORY_UPDATES and CATEGORY_FORUMS. Filtering by
 * label rather than a `q` search keeps the result exact: a message is in Primary or it is not.
 */
const PRIMARY_LABEL = 'CATEGORY_PERSONAL'
const CATEGORY_LABEL_PREFIX = 'CATEGORY_'

/** The largest page `messages.list` will return. */
const LIST_PAGE_SIZE = 500

/**
 * Not a product cap: the queue is meant to hold the whole Primary tab. This only stops a mailbox
 * with thousands of unread messages from keeping "fetching" on screen for minutes.
 */
const MAX_UNREAD = 2000

/** Parallel `messages.get` calls. High enough to be quick, low enough to stay under the rate limit. */
const METADATA_CONCURRENCY = 8

/** How many unread inbox messages to inspect when deciding whether the account uses tabs at all. */
const CATEGORY_SAMPLE_SIZE = 25

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
   * Every unread message in the Primary tab, newest first.
   *
   * `labelIds` is an AND filter, so INBOX + UNREAD + CATEGORY_PERSONAL is exactly "unread in
   * Primary". Promotions, Social, Updates and Forums never match. The list is paged to the end
   * rather than taking the first page, so a busy inbox is read in full.
   */
  async listPrimaryUnread(): Promise<EmailHeader[]> {
    const api = await this.ensureApi()

    let ids = await this.listAllIds(api, ['INBOX', 'UNREAD', PRIMARY_LABEL])

    if (ids.length === 0 && !(await this.inboxUsesCategories(api))) {
      // Some accounts carry no CATEGORY_* labels at all, so Primary is not a thing there and the
      // whole inbox is what the user sees as their mail. Only reached when the sample found no
      // categories; an account whose Primary is simply empty stays empty.
      log.info('no category labels on unread inbox mail; tabs are off, reading the whole inbox')
      ids = await this.listAllIds(api, ['INBOX', 'UNREAD'])
    }

    if (ids.length === 0) return []

    // Two-phase fetch: metadata for the queue, full bodies only for what is actually opened.
    // Bounded concurrency, because a few hundred simultaneous requests trip the per-user rate limit.
    const headers = await mapWithConcurrency(ids, METADATA_CONCURRENCY, async (id) => {
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
    })

    // Kept so that "do my emails" still has an answer when the network is down later.
    cacheHeaders(headers)
    return headers
  }

  /** Follows `nextPageToken` until Gmail runs out of messages or MAX_UNREAD is reached. */
  private async listAllIds(api: gmail_v1.Gmail, labelIds: string[]): Promise<string[]> {
    const ids: string[] = []
    let pageToken: string | undefined

    do {
      const response = await withRateLimitRetry(() =>
        api.users.messages.list({
          userId: 'me',
          labelIds,
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

  /**
   * Whether Gmail is stamping CATEGORY_* labels on this inbox. Looks at a sample of unread inbox
   * mail; any category label on any of it means tabs are in play and an empty Primary is real.
   * An empty inbox counts as categorised, since there is nothing to read either way.
   */
  private async inboxUsesCategories(api: gmail_v1.Gmail): Promise<boolean> {
    const response = await withRateLimitRetry(() =>
      api.users.messages.list({
        userId: 'me',
        labelIds: ['INBOX', 'UNREAD'],
        includeSpamTrash: false,
        maxResults: CATEGORY_SAMPLE_SIZE,
        fields: 'messages/id'
      })
    )
    const sampleIds = (response.data.messages ?? []).map((message) => message.id).filter(Boolean)
    if (sampleIds.length === 0) return true

    const labelSets = await mapWithConcurrency(sampleIds, METADATA_CONCURRENCY, async (id) => {
      const message = await withRateLimitRetry(() =>
        api.users.messages.get({ userId: 'me', id: id!, format: 'minimal', fields: 'labelIds' })
      )
      return message.data.labelIds ?? []
    })
    return labelSets.some((labels) =>
      labels.some((label) => label.startsWith(CATEGORY_LABEL_PREFIX))
    )
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

/**
 * Retries a Gmail call a few times with backoff when the rate limit bites. Anything else is
 * rethrown as-is, so a real failure still surfaces at once.
 */
async function withRateLimitRetry<T>(call: () => Promise<T>, attempts = 4): Promise<T> {
  let delay = 500
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call()
    } catch (error) {
      if (!isRateLimited(error) || attempt >= attempts) throw error
      log.warn(`rate limited; retrying in ${delay}ms (attempt ${attempt} of ${attempts})`)
      await new Promise((resolve) => setTimeout(resolve, delay))
      delay *= 2
    }
  }
}

/** `Promise.all` with at most `limit` tasks running at once, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await fn(items[index])
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

export const gmail = new GmailService()
