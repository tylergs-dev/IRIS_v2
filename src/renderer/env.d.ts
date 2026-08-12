/// <reference types="vite/client" />

import type { IrisApi } from '../preload'

declare global {
  interface Window {
    iris: IrisApi
  }
}
