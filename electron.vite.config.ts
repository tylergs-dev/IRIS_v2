import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { audioWorklet } from './build/vite-plugin-audio-worklet'

const shared = resolve('src/shared')

/**
 * Baked in at build time rather than read at runtime: a packaged Windows app inherits no useful
 * environment, so an env lookup in the shipped binary would always be empty.
 */
const updateFeed = JSON.stringify(process.env.IRIS_UPDATE_FEED ?? '')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: { __IRIS_UPDATE_FEED__: updateFeed },
    resolve: {
      alias: { '@shared': shared, '@main': resolve('src/main') }
    },
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': shared }
    },
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [audioWorklet(), react()],
    resolve: {
      alias: { '@shared': shared, '@renderer': resolve('src/renderer') }
    },
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
    }
  }
})
