import { shell } from 'electron'
import { getHistory } from '../../chat/log'
import { getHealth } from '../../health'
import { onboarding } from '../../onboarding/OnboardingMachine'
import { browser } from '../../skills/browse/BrowserService'
import { emit, handle } from '../register'
import {
  clearSecret,
  secretsPresence,
  setSecret
} from '../../storage/secrets'
import { getProfile, onProfileChange, setProfile } from '../../storage/profile'

export function registerSystemChannels(): void {
  handle('chat:history', () => getHistory())
  handle('health:get', () => getHealth())

  handle('shell:openExternal', async (url) => {
    // Only ever hand https to the OS; anything else could be a local scheme handler.
    if (!/^https:\/\//i.test(url)) throw new Error('Refusing to open non-https URL')
    await shell.openExternal(url)
  })

  handle('profile:get', () => getProfile())
  handle('profile:set', (patch) => {
    setProfile(patch)
  })

  handle('onboarding:start', async () => {
    await onboarding.start()
  })

  handle('browse:signIn', async (url) => {
    await browser.openSignInSession(url)
  })

  handle('keys:presence', () => secretsPresence())
  handle('keys:set', async (name, value) => {
    await setSecret(name, value)
    emit('keys:changed', await secretsPresence())
  })
  handle('keys:clear', async (name) => {
    await clearSecret(name)
    emit('keys:changed', await secretsPresence())
  })

  onProfileChange((profile) => emit('profile:changed', profile))
}
