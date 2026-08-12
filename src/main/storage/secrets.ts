import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { SecretName, SecretsPresence } from '../../shared/types'
import { createLogger } from '../log'

const log = createLogger('secrets')

type Secrets = Partial<Record<SecretName, string>>

let cache: Secrets | null = null
let file: string | null = null

function secretsFile(): string {
  file ??= path.join(app.getPath('userData'), 'secrets.enc')
  return file
}

/**
 * Must run after `app.whenReady()` — `isEncryptionAvailable()` only reports correctly once
 * the app is ready. On Linux a missing keyring silently degrades to the `basic_text` backend,
 * which derives its key from a publicly known hardcoded password, so we refuse to store
 * anything rather than write credentials that only look encrypted.
 */
export function assertStorageSecure(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS secure storage is unavailable; refusing to store credentials.')
  }
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    throw new Error(
      'No system keyring detected. The basic_text fallback is not real encryption. ' +
        'Install gnome-keyring or kwallet, or start with --password-store=gnome-libsecret.'
    )
  }
}

async function load(): Promise<Secrets> {
  if (cache) return cache
  try {
    const blob = await fs.readFile(secretsFile())
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(blob)
    cache = JSON.parse(result) as Secrets
    // The OS rotated the key or offers a stronger one; rewrite so we stay on the current key.
    if (shouldReEncrypt) await persist(cache)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      cache = {}
    } else {
      // An OS reinstall, a new user profile, or a reset keyring all land here. This is not
      // recoverable, so start clean and let the caller re-authenticate rather than crash.
      log.error('could not decrypt secrets store; starting empty', error)
      cache = {}
    }
  }
  return cache
}

async function persist(secrets: Secrets): Promise<void> {
  const blob = await safeStorage.encryptStringAsync(JSON.stringify(secrets))
  const target = secretsFile()
  const tmp = `${target}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, blob, { mode: 0o600 })
  await fs.rename(tmp, target)
}

export async function getSecret(name: SecretName): Promise<string | undefined> {
  return (await load())[name]
}

export async function setSecret(name: SecretName, value: string): Promise<void> {
  const secrets = await load()
  const trimmed = value.trim()
  if (trimmed) secrets[name] = trimmed
  else delete secrets[name]
  await persist(secrets)
}

export async function clearSecret(name: SecretName): Promise<void> {
  const secrets = await load()
  delete secrets[name]
  await persist(secrets)
}

export async function secretsPresence(): Promise<SecretsPresence> {
  const secrets = await load()
  return {
    geminiApiKey: Boolean(secrets.geminiApiKey),
    tavilyApiKey: Boolean(secrets.tavilyApiKey),
    googleRefreshToken: Boolean(secrets.googleRefreshToken),
    googleClientId: Boolean(secrets.googleClientId),
    googleClientSecret: Boolean(secrets.googleClientSecret)
  }
}
