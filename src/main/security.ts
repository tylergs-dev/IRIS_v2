export const APP_SCHEME = 'app:'
export const APP_HOST = 'iris'
export const APP_ORIGIN = `${APP_SCHEME}//${APP_HOST}`

/**
 * `app:` is not a "special" scheme in the URL spec, so `new URL('app://iris/x').origin` is the
 * string "null" rather than "app://iris". Comparing protocol and host is the only reliable check.
 */
function matches(value: string, protocol: string, host: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === protocol && url.host === host
  } catch {
    return false
  }
}

export function isAppUrl(value: string | undefined | null): boolean {
  return Boolean(value) && matches(value!, APP_SCHEME, APP_HOST)
}

export function isDevUrl(value: string | undefined | null): boolean {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!devUrl || !value) return false
  try {
    const dev = new URL(devUrl)
    return matches(value, dev.protocol, dev.host)
  } catch {
    return false
  }
}

/** True for our own renderer document, in either dev or production. */
export function isTrustedUrl(value: string | undefined | null): boolean {
  return isAppUrl(value) || isDevUrl(value)
}
