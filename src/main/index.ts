// MUST STAY FIRST. Velopack's startup hooks run as a side effect of this import and exit the
// process on install, update, and uninstall. See the file itself for why it is an import rather
// than a statement here. Nothing may be added above it.
import './update/velopack-boot'

import { app, BrowserWindow, globalShortcut } from 'electron'
import { registerAuthChannels } from './ipc/channels/auth'
import { registerEmailChannels } from './ipc/channels/email'
import { registerSystemChannels } from './ipc/channels/system'
import { registerUpdateChannels } from './ipc/channels/update'
import { registerVoiceChannels } from './ipc/channels/voice'
import { registerFallbacks } from './ipc/register'
import { createLogger } from './log'
import { notice, setNoticeSpeaker } from './notify'
import { gmail } from './skills/email/GmailService'
import { flushHeaderCache } from './skills/email/header-cache'
import { undoStack } from './skills/email/undo'
import { registerOnboardingTools } from './onboarding/tools'
import { browser } from './skills/browse/BrowserService'
import { registerSettingsTools } from './settings/tools'
import { registerEmailSkill, registerResearchSkills } from './skills/SkillOrchestrator'
import { flushProfile } from './storage/profile'
import { flushReadingList } from './storage/reading-list'
import { assertStorageSecure } from './storage/secrets'
import { updates } from './update/UpdateService'
import { voice } from './voice/VoiceSessionManager'
import { startWakeWord } from './wake'
import { createMainWindow, registerAppScheme } from './window'

const log = createLogger('main')

registerAppScheme()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  void bootstrap()
}

async function bootstrap(): Promise<void> {
  await app.whenReady()

  let storageSecure = true
  try {
    assertStorageSecure()
  } catch (error) {
    // Not fatal on its own: the app still works, but nothing may be persisted. The renderer
    // speaks this rather than failing silently the first time a key is saved.
    storageSecure = false
    log.error('secure storage unavailable', error)
  }

  // Before anything can raise a notice, so the first failure is spoken rather than only drawn.
  setNoticeSpeaker((text) => voice.trySpeak(text))

  registerSystemChannels()
  registerVoiceChannels()
  registerAuthChannels()
  registerEmailChannels()
  registerEmailSkill()
  registerResearchSkills()
  registerOnboardingTools()
  registerSettingsTools()
  registerUpdateChannels()
  registerFallbacks()
  registerShortcuts()

  // Counted before the first check so "two launches since they declined" is accurate.
  updates.countLaunch()

  const window = createMainWindow()

  window.webContents.once('did-finish-load', () => {
    if (!storageSecure) {
      notice(
        'error',
        'Your system’s secure storage is unavailable, so I cannot save your keys or sign-in. ' +
          'Everything else will work until you close IRIS.'
      )
    }
  })

  // Reconnecting up front means the Skills tab and the health indicator are accurate before the
  // user asks for anything, and a stale refresh token surfaces now rather than mid-conversation.
  void restoreGmail()

  // Deferred so the check never competes with startup, and so the first thing a user hears is
  // IRIS greeting them rather than talking about itself.
  setTimeout(() => void updates.checkQuietly(), 45_000)

  // No-ops when no trained model is present, leaving the hotkey as the way in.
  void startWakeWord()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
}

async function restoreGmail(): Promise<void> {
  if (!(await gmail.isConfigured())) return
  try {
    await gmail.listLabels()
    gmail.startPolling()
  } catch (error) {
    log.warn('could not restore the Gmail session', error)
    notice(
      'warning',
      'I could not reconnect to your Gmail just now. Everything else works — ask me to connect ' +
        'Gmail again if it keeps happening.'
    )
  }
}

/**
 * Stands in for the wake word until Phase 8, and stays afterwards as a permanent alternative for
 * anyone who cannot rely on voice activation.
 */
function registerShortcuts(): void {
  const wake = 'CommandOrControl+Shift+I'
  const stop = 'CommandOrControl+Shift+S'

  if (!globalShortcut.register(wake, () => void voice.wake())) {
    log.warn(`could not register ${wake}; another app likely owns it`)
    notice(
      'warning',
      'I could not claim the keyboard shortcut for waking me up. Another program is already ' +
        'using it. You can still use the Wake button.'
    )
  }
  if (!globalShortcut.register(stop, () => voice.stop())) {
    log.warn(`could not register ${stop}`)
  }
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  gmail.stopPolling()
  voice.dispose()
  // Orphaned browser processes would keep running after IRIS exits.
  void browser.close()
  void Promise.all([
    flushProfile(),
    flushReadingList(),
    flushHeaderCache(),
    undoStack.settled(),
    updates.flush()
  ])
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
