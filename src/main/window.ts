import { BrowserWindow, protocol, session, shell } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setRendererTarget } from './ipc/register'
import { createLogger } from './log'
import { APP_ORIGIN, isTrustedUrl } from './security'

const log = createLogger('window')

const RENDERER_ROOT = path.join(__dirname, '../renderer')
const PRELOAD = path.join(__dirname, '../preload/index.js')

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

export function createMainWindow(): BrowserWindow {
  handleAppProtocol()
  configurePermissions()

  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#05070d',
    title: 'IRIS',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  lockDownNavigation(window.webContents)
  setRendererTarget(window.webContents)
  forwardRendererDiagnostics(window.webContents)

  window.once('ready-to-show', () => window.show())

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void window.loadURL(devUrl)
  else void window.loadURL(`${APP_ORIGIN}/index.html`)

  return window
}
