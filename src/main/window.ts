import { BrowserWindow, protocol, screen, session, shell } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { IpcEventName } from '../shared/ipc'
import { addRendererTarget } from './ipc/register'
import { createLogger } from './log'
import { APP_ORIGIN, isTrustedUrl } from './security'

const log = createLogger('window')

const RENDERER_ROOT = path.join(__dirname, '../renderer')
const PRELOAD = path.join(__dirname, '../preload/index.js')

/**
 * The renderer bundle is one document; the hash picks which root it mounts. `#inbox` is the
 * email popout. See `src/renderer/main.tsx`.
 */
export const INBOX_HASH = '#inbox'

/** The only pushes the inbox popout draws. Everything else — above all audio — stays home. */
const INBOX_EVENTS: readonly IpcEventName[] = [
  'email:snapshot',
  'auth:changed',
  'health:changed',
  'voice:state'
]

const WEB_PREFERENCES: Electron.WebPreferences = {
  preload: PRELOAD,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true
}

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
}

// Sent only for production `app://` documents. Vite's dev server needs inline scripts for HMR,
// so dev intentionally runs without this rather than weakening the shipped policy.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join('; ')

/** Must be called before `app.whenReady()`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
    }
  ])
}

/**
 * Serving the renderer from `app://` rather than `file://` matters: a `file://` document has
 * unilateral read access to the whole filesystem, so any XSS becomes file exfiltration.
 */
function handleAppProtocol(): void {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url)
    if (url.host !== 'iris') return new Response('Not found', { status: 404 })

    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    const resolved = path.resolve(RENDERER_ROOT, relative)

    if (!resolved.startsWith(path.resolve(RENDERER_ROOT) + path.sep)) {
      log.warn('blocked traversal attempt', relative)
      return new Response('Forbidden', { status: 403 })
    }

    try {
      const body = await fs.readFile(resolved)
      const extension = path.extname(resolved).toLowerCase()
      const headers: Record<string, string> = {
        'Content-Type': MIME[extension] ?? 'application/octet-stream',
        'Cache-Control': 'no-store'
      }
      if (extension === '.html') headers['Content-Security-Policy'] = CSP
      return new Response(body, { headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function configurePermissions(): void {
  const ses = session.defaultSession

  // Electron grants media by default. Both handlers are needed: most web APIs run a
  // permission *check* first and only fall back to a *request* if the check is denied.
  const allowed = new Set(['media', 'audioCapture'])

  ses.setPermissionRequestHandler((contents, permission, callback) => {
    callback(isTrustedUrl(contents.getURL()) && allowed.has(permission))
  })

  ses.setPermissionCheckHandler((_contents, permission, origin) => {
    return isTrustedUrl(origin) && allowed.has(permission)
  })
}

/** Checklist items 13 and 14: no in-app navigation away from our origin, no popups. */
function lockDownNavigation(contents: Electron.WebContents): void {
  contents.on('will-navigate', (event, url) => {
    if (isTrustedUrl(url)) return
    event.preventDefault()
    log.warn('blocked in-app navigation', url)
  })

  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}

/**
 * The renderer has no visible devtools in a shipped build, and the primary user cannot read a
 * console anyway, so surface renderer failures in the main process log where they are findable.
 */
function forwardRendererDiagnostics(contents: Electron.WebContents): void {
  contents.on('console-message', (event) => {
    if (event.level === 'error') log.error(`renderer: ${event.message}`)
    else if (event.level === 'warning') log.warn(`renderer: ${event.message}`)
    else log.debug(`renderer: ${event.message}`)
  })

  contents.on('did-fail-load', (_event, code, description, url) => {
    log.error(`renderer failed to load (${code} ${description})`, url)
  })

  contents.on('render-process-gone', (_event, details) => {
    log.error('renderer process gone', details)
  })

  contents.on('preload-error', (_event, preloadPath, error) => {
    log.error(`preload failed: ${preloadPath}`, error)
  })
}

/** Dev server or the packaged `app://` document, with an optional hash to pick the root. */
function rendererUrl(hash = ''): string {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  return (devUrl ?? `${APP_ORIGIN}/index.html`) + hash
}

let protocolReady = false

export function createMainWindow(): BrowserWindow {
  // Both are process-wide; `activate` on macOS can create the window more than once.
  if (!protocolReady) {
    handleAppProtocol()
    configurePermissions()
    protocolReady = true
  }

  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#05070d',
    title: 'IRIS',
    autoHideMenuBar: true,
    webPreferences: WEB_PREFERENCES
  })

  lockDownNavigation(window.webContents)
  addRendererTarget(window.webContents)
  forwardRendererDiagnostics(window.webContents)

  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  void window.loadURL(rendererUrl())

  mainWindow = window
  return window
}

/**
 * Where to put the popout: beside the main window when the display has room, otherwise
 * overlapping its right edge so it is still obviously attached to IRIS.
 */
function inboxBounds(parent: BrowserWindow, width: number, height: number): Electron.Rectangle {
  const anchor = parent.getBounds()
  const area = screen.getDisplayMatching(anchor).workArea
  const gap = 12

  let x = anchor.x + anchor.width + gap
  if (x + width > area.x + area.width) x = Math.max(area.x, area.x + area.width - width)
  const y = Math.min(Math.max(anchor.y, area.y), area.y + area.height - height)
  return { x, y, width, height }
}

/**
 * The email-mode inbox as its own window, so a sighted helper can keep it beside the
 * conversation or on another screen. A child of the main window: it rides along when that moves,
 * minimises with it, and closes with it. Not modal — the main window stays usable.
 */
export function createInboxWindow(parent: BrowserWindow): BrowserWindow {
  const width = 780
  const height = 580

  const window = new BrowserWindow({
    ...inboxBounds(parent, width, height),
    minWidth: 560,
    minHeight: 400,
    parent,
    show: false,
    backgroundColor: '#05070d',
    title: 'IRIS — Inbox',
    autoHideMenuBar: true,
    webPreferences: WEB_PREFERENCES
  })

  lockDownNavigation(window.webContents)
  addRendererTarget(window.webContents, INBOX_EVENTS)
  forwardRendererDiagnostics(window.webContents)

  window.once('ready-to-show', () => window.show())

  void window.loadURL(rendererUrl(INBOX_HASH))

  return window
}
