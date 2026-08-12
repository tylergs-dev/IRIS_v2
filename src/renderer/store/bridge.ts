import { applyDelta, pushNotice, upsertMessage, useStore } from './index'

/**
 * Wires main-process pushes straight into the Zustand store. Deliberately outside React:
 * chat deltas arrive many times a second, and routing them through context would re-render
 * the whole tree and make screen readers re-announce content.
 */
export function connectBridge(): () => void {
  const off: Array<() => void> = []

  off.push(window.iris.on('voice:state', (voiceState) => useStore.setState({ voiceState })))
  off.push(window.iris.on('voice:cost', (cost) => useStore.setState({ cost })))
  off.push(window.iris.on('chat:message', upsertMessage))
  off.push(window.iris.on('chat:delta', ({ id, text }) => applyDelta(id, text)))
  off.push(window.iris.on('task:update', (task) => useStore.setState({ task })))
  off.push(window.iris.on('email:snapshot', (email) => useStore.setState({ email })))
  off.push(window.iris.on('profile:changed', (profile) => useStore.setState({ profile })))
  off.push(window.iris.on('health:changed', (health) => useStore.setState({ health })))
  off.push(window.iris.on('auth:changed', (account) => useStore.setState({ account })))
  off.push(window.iris.on('keys:changed', (keys) => useStore.setState({ keys })))
  off.push(window.iris.on('reading:changed', (readingList) => useStore.setState({ readingList })))
  off.push(
    window.iris.on('notice', ({ severity, text, spoken }) => pushNotice(severity, text, spoken))
  )

  void hydrate()

  return () => {
    for (const unsubscribe of off) unsubscribe()
  }
}

async function hydrate(): Promise<void> {
  const [messages, profile, health, keys] = await Promise.all([
    window.iris.invoke('chat:history'),
    window.iris.invoke('profile:get'),
    window.iris.invoke('health:get'),
    window.iris.invoke('keys:presence')
  ])
  useStore.setState({ messages, profile, health, keys })
}
