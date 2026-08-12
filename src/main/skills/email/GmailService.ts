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

/** Categories that must never reach the user's ear. */
const EXCLUDED_CATEGORIES = ['promotions', 'social', 'updates', 'forums']

const MAX_QUEUE = 25

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
   * Unread messages in the Primary tab.
   *
   * `labelIds` is an AND filter and there is no way to express "not in these categories" with it,
   * so the negations have to live in `q`. Note the Primary tab's label is CATEGORY_PERSONAL, not
   * CATEGORY_PRIMARY — but `category:primary` is the correct search operator for it.
   */
  async listPrimaryUnread(): Promise<EmailHeader[]> {
    const api = await this.ensureApi()

    const negations = EXCLUDED_CATEGORIES.map((category) => `-category:${category}`).join(' ')
    let ids = await this.listIds(api, `category:primary ${negations}`)

    if (ids.length === 0) {
      // Inbox tabs can be turned off entirely, in which case nothing carries a category label and
      // `category:primary` matches nothing. Without this the user hears "no new mail" while
      // staring at a full inbox.
      const total = await this.listIds(api, '')
      if (total.length > 0) {
        log.info('category:primary matched nothing but the inbox is not empty; tabs likely off')
        ids = await this.listIds(api, negations)
      }
    }

    if (ids.length === 0) return []

    // Two-phase fetch: metadata for the queue, full bodies only for what is actually opened.
    const headers = await Promise.all(
      ids.map(async (id) => {
        const message = await api.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date']
        })
        return toHeader(message.data)
      })
    )

    // Kept so that "do my emails" still has an answer when the network is down later.
    cacheHeaders(headers)
    return headers
  }

  private async listIds(api: gmail_v1.Gmail, query: string): Promise<string[]> {
    const response = await api.users.messages.list({
      userId: 'me',
      labelIds: ['INBOX', 'UNREAD'],
      ...(query.trim() ? { q: query.trim() } : {}),
      // Default, but stated so a later refactor cannot quietly start reading spam aloud.
      includeSpamTrash: false,
      maxResults: MAX_QUEUE,
      fields: 'messages/id,nextPageToken'
    })
    return (response.data.messages ?? []).map((message) => message.id!).filter(Boolean)
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

export const gmail = new GmailService()
