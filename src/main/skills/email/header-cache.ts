import type { EmailHeader } from '../../../shared/types'
import { JsonStore } from '../../storage/json-store'

/**
 * The last inbox queue IRIS successfully fetched, kept on disk.
 *
 * This exists for one situation: the network is down and the user asks to do their email. Without
 * it the only possible answer is "I cannot reach Gmail", which tells them nothing about their own
 * mail. With it IRIS can still say who wrote and what about, as of the last time it looked — which
 * is usually the actual question behind "anything new?".
 *
 * Headers only, never bodies. A body is large, is the private part, and cannot be summarized
 * offline anyway since summarizing needs the model.
 */
interface CacheShape {
  headers: EmailHeader[]
  fetchedAt: number | null
}

let store: JsonStore<CacheShape> | null = null

function getStore(): JsonStore<CacheShape> {
  // Constructed on first use: it resolves userData, which does not exist before app ready.
  store ??= new JsonStore<CacheShape>('inbox-cache', { headers: [], fetchedAt: null })
  return store
}

export function cacheHeaders(headers: EmailHeader[]): void {
  getStore().replace({ headers, fetchedAt: Date.now() })
}

export function cachedHeaders(): CacheShape {
  return getStore().get()
}

/** Called on disconnect: the cache is somebody's mail, and it should not outlive their sign-in. */
export function clearCachedHeaders(): void {
  getStore().replace({ headers: [], fetchedAt: null })
}

export async function flushHeaderCache(): Promise<void> {
  await getStore().settled()
}
