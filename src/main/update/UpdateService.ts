import { app } from 'electron'
import { UpdateManager, type UpdateInfo } from 'velopack'
import { createLogger } from '../log'
import { JsonStore } from '../storage/json-store'
import { voice } from '../voice/VoiceSessionManager'

const log = createLogger('update')

/**
 * The release feed. Must be HTTPS: applying an update is arbitrary code execution, and Velopack's
 * HTTP client uses bundled webpki roots rather than the OS trust store, so a corporate TLS
 * intercept shows up here as `invalid peer certificate: UnknownIssuer` — that is a certificate
 * problem to fix at the host or network, never a reason to downgrade to plain HTTP.
 */
const FEED_URL = __IRIS_UPDATE_FEED__

/** Declining must not mean being asked again on the next launch. Both conditions must pass. */
const DECLINE_COOLDOWN_MS = 72 * 60 * 60 * 1000
const DECLINE_COOLDOWN_LAUNCHES = 2

interface UpdateState {
  declinedVersion: string | null
  declinedAt: number | null
  launchesSinceDecline: number
}

const defaults: UpdateState = { declinedVersion: null, declinedAt: null, launchesSinceDecline: 0 }

class UpdateService {
  private manager: UpdateManager | null = null
  private store: JsonStore<UpdateState> | null = null
  /** Held between the download finishing and the user answering the spoken prompt. */
  private ready: UpdateInfo | null = null
  private checking = false

  /**
   * Kept out of the app directory deliberately: Velopack replaces `current/` wholesale on update,
   * so anything stored beside the executable is destroyed by the very thing it is tracking.
   */
  private getStore(): JsonStore<UpdateState> {
    this.store ??= new JsonStore('update', defaults)
    return this.store
  }

  private getManager(): UpdateManager | null {
    if (!FEED_URL) return null
    if (!/^https:\/\//i.test(FEED_URL)) {
      log.error('refusing a non-HTTPS update feed; updates are disabled')
      return null
    }
    try {
      this.manager ??= new UpdateManager(FEED_URL)
      return this.manager
    } catch (error) {
      // NotInstalledException: normal in development and for a portable copy.
      log.info('not a Velopack install, updates disabled', error)
      return null
    }
  }

  /** Called once per launch, before any check, so the cooldown counts launches accurately. */
  countLaunch(): void {
    const state = this.getStore().get()
    if (state.declinedAt === null) return
    this.getStore().set({ launchesSinceDecline: state.launchesSinceDecline + 1 })
  }

  private mayAskAbout(version: string): boolean {
    const state = this.getStore().get()
    if (state.declinedVersion !== version || state.declinedAt === null) return true
    const waited = Date.now() - state.declinedAt >= DECLINE_COOLDOWN_MS
    const launched = state.launchesSinceDecline >= DECLINE_COOLDOWN_LAUNCHES
    // "Whichever is later" — both must be satisfied.
    return waited && launched
  }

  /**
   * Silent by design: check and download happen with no announcement, and the user only hears
   * anything once there is a finished download and a decision worth making.
   */
  async checkQuietly(): Promise<{ available: boolean; version: string | null }> {
    const manager = this.getManager()
    if (!manager || this.checking) return { available: false, version: null }

    this.checking = true
    try {
      const pending = manager.getUpdatePendingRestart()
      if (pending) {
        log.info(`update ${pending.Version} already downloaded, awaiting restart`)
        return { available: true, version: pending.Version }
      }

      const update = await manager.checkForUpdatesAsync()
      if (!update) return { available: false, version: null }

      const version = update.TargetFullRelease.Version
      log.info(`update ${version} available, downloading`)
      await manager.downloadUpdateAsync(update)
      this.ready = update

      if (this.mayAskAbout(version)) await this.offer(version)
      else log.info(`not offering ${version} again yet; still within the decline cooldown`)

      return { available: true, version }
    } catch (error) {
      // A failed update check must never be user-visible: it changes nothing they can act on.
      log.warn('update check failed', error)
      return { available: false, version: null }
    } finally {
      this.checking = false
    }
  }

  /** Spoken through the normal voice path so it sounds like IRIS, not like a notification. */
  private async offer(version: string): Promise<void> {
    await voice.inject(
      'system',
      `A new version of yourself, ${version}, has finished downloading and is ready to install. ` +
        'Mention this once, briefly, at a natural pause — never interrupt what they are doing. ' +
        'Say installing takes a few seconds and restarts you. If they agree, call install_update. ' +
        'If they decline or want it later, call postpone_update. Do not raise it again afterwards.'
    )
  }

  /**
   * Velopack's updater waits for this process to exit, so quitting is part of applying — not
   * something to do afterwards.
   */
  applyNow(): boolean {
    const manager = this.getManager()
    const target = this.ready ?? manager?.getUpdatePendingRestart() ?? null
    if (!manager || !target) return false

    try {
      // `silent` defaults to false, which would show an installer window nobody can navigate.
      manager.waitExitThenApplyUpdate(target, true, true)
    } catch (error) {
      log.error('could not hand off to the updater', error)
      return false
    }

    log.info('quitting to let the updater run')
    app.quit()
    return true
  }

  postpone(): void {
    const version = this.ready?.TargetFullRelease.Version ?? null
    this.getStore().set({
      declinedVersion: version,
      declinedAt: Date.now(),
      launchesSinceDecline: 0
    })
    log.info(`update ${version ?? 'unknown'} postponed`)
  }

  pendingVersion(): string | null {
    return this.ready?.TargetFullRelease.Version ?? null
  }

  async flush(): Promise<void> {
    await this.store?.settled()
  }
}

export const updates = new UpdateService()
