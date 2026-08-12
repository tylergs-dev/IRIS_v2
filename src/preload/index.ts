import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, IPC_EVENTS } from '../shared/ipc'
import type { IpcChannel, IpcContract, IpcEventName, IpcEvents } from '../shared/ipc'

const channels = new Set<string>(IPC_CHANNELS)
const events = new Set<string>(IPC_EVENTS)

const api = {
  invoke<C extends IpcChannel>(
    channel: C,
    ...args: IpcContract[C]['args']
  ): Promise<IpcContract[C]['ret']> {
    if (!channels.has(channel)) {
      return Promise.reject(new Error(`Unknown IPC channel: ${String(channel)}`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },

  /**
   * Returns an unsubscribe function so React effects can clean up. The IpcRendererEvent is
   * deliberately destructured away — handing it to the renderer would expose `event.sender`.
   */
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): () => void {
    if (!events.has(event)) throw new Error(`Unknown IPC event: ${String(event)}`)
    const handler = (_event: unknown, payload: IpcEvents[E]): void => listener(payload)
    ipcRenderer.on(event, handler)
    return () => {
      ipcRenderer.off(event, handler)
    }
  },

  /** Zero-copy path for the mic. Transfers the buffer rather than structured-cloning it. */
  sendAudioChunk(pcm: ArrayBuffer): void {
    ipcRenderer.send('voice:audioChunk', pcm)
  }
}

export type IrisApi = typeof api

contextBridge.exposeInMainWorld('iris', api)
