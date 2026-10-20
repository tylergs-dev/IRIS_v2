/// <reference types="vite/client" />

import type { IrisApi } from '../preload'

declare global {
  interface Window {
    iris: IrisApi
  }

  /** package.json version, replaced by electron-vite's `define` at build time. */
  const __IRIS_VERSION__: string
}
