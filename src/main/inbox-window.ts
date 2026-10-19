import { app, type BrowserWindow } from 'electron'
import { createLogger } from './log'
import { emailMode, runEmailUiAction } from './skills/SkillOrchestrator'
import { createInboxWindow, getMainWindow } from './window'

const log = createLogger('inbox-window')

let inbox: BrowserWindow | null = null

/** Windows we closed because email mode ended, as opposed to the user closing them. */
const closedByApp = new WeakSet<BrowserWindow>()

let quitting = false

/**
 * Ties the inbox popout to email mode: it appears when the mode starts and goes away when the
 * mode ends, however either happened. Closing the window by hand is read as "leave email mode",
 * the same as the Leave button, so the two never disagree about whether the mode is running.
 */
export function installInboxWindow(): void {
  app.on('before-quit', () => {
    quitting = true
  })

  emailMode.onPhaseChange((phase) => {
    if (phase === 'idle') closeInbox()
    else openInbox()
  })
}

function openInbox(): void {
  if (inbox && !inbox.isDestroyed()) {
    if (inbox.isMinimized()) inbox.restore()
    return
  }

  const parent = getMainWindow()
  if (!parent) {
    log.warn('email mode started with no main window; inbox popout not shown')
    return
  }

  const window = createInboxWindow(parent)
  inbox = window

  window.on('closed', () => {
    if (inbox === window) inbox = null
    if (closedByApp.has(window) || quitting) return
    // Closing the parent takes this window with it; on quit the voice layer is already going
    // away, so only a deliberate close while the mode is still running is treated as leaving.
    if (emailMode.snapshot().phase === 'idle') return
    log.info('inbox window closed by the user; leaving email mode')
    void runEmailUiAction({ type: 'stop' })
  })
}

function closeInbox(): void {
  const window = inbox
  inbox = null
  if (!window || window.isDestroyed()) return
  closedByApp.add(window)
  window.close()
}
