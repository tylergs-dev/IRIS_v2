import type { ConnectionState, ServiceHealth } from '../shared/types'
import { emit } from './ipc/register'

const health: ServiceHealth = {
  voice: 'offline',
  gmail: 'offline',
  search: 'offline',
  browser: 'offline',
  wakeWord: 'offline'
}

export function getHealth(): ServiceHealth {
  return { ...health }
}

export function setHealth(service: keyof ServiceHealth, state: ConnectionState): void {
  if (health[service] === state) return
  health[service] = state
  emit('health:changed', getHealth())
}
