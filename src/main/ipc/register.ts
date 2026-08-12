import { ipcMain, type WebContents, type WebFrameMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc'
import type { IpcChannel, IpcContract, IpcEventName, IpcEvents } from '../../shared/ipc'
import { createLogger } from '../log'
import { isTrustedUrl } from '../security'

const log = createLogger('ipc')

const registered = new Set<IpcChannel>()

let target: WebContents | null = null

export function setRendererTarget(contents: WebContents): void {
  target = contents
  contents.once('destroyed', () => {
    if (target === contents) target = null
  })
}

/**
 * Security checklist item 17. The main process holds Gmail tokens and API keys, so every
 * privileged call is rejected unless it came from our own renderer document.
 */
function isTrustedFrame(frame: WebFrameMain | null): boolean {
  return Boolean(frame) && isTrustedUrl(frame!.url)
}

/** Registers a request/response channel. */
export function handle<C extends IpcChannel>(
  channel: C,
  fn: (...args: IpcContract[C]['args']) => Promise<IpcContract[C]['ret']> | IpcContract[C]['ret']
): void {
  registered.add(channel)
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedFrame(event.senderFrame)) {
      log.warn(`rejected ${channel} from untrusted frame`, event.senderFrame?.url)
      throw new Error('Untrusted sender')
    }
    return fn(...(args as IpcContract[C]['args']))
  })
}

/** Registers a fire-and-forget channel, used for the high-rate mic stream. */
export function listen<C extends IpcChannel>(
  channel: C,
  fn: (...args: IpcContract[C]['args']) => void
): void {
  registered.add(channel)
  ipcMain.on(channel, (event, ...args) => {
    if (!isTrustedFrame(event.senderFrame)) return
    fn(...(args as IpcContract[C]['args']))
  })
}

/**
 * Safety net so a channel that exists in the contract but has no implementation on this
 * platform or build fails with a readable message instead of an opaque "no handler" error.
 * Call once, after every real registration.
 */
export function registerFallbacks(): void {
  for (const channel of IPC_CHANNELS) {
    if (registered.has(channel)) continue
    log.warn(`no implementation for ${channel}; registering fallback`)
    ipcMain.handle(channel, () => {
      throw new Error(`“${channel}” is not available in this build.`)
    })
  }
}

export function emit<E extends IpcEventName>(event: E, payload: IpcEvents[E]): void {
  if (!target || target.isDestroyed()) return
  target.send(event, payload)
}
