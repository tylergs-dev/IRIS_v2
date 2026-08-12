import { shell } from 'electron'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library'
import { createLogger } from '../log'
import { getSecret, setSecret } from '../storage/secrets'

const log = createLogger('oauth')

/**
 * `gmail.modify` only. It covers reading, labelling, and trashing, and deliberately excludes
 * `mail.google.com`, so permanent deletion is not reachable by any code path in this app.
 */
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify']

/** Long enough for a screen-reader user to work through Google's consent screens unhurried. */
const FLOW_TIMEOUT_MS = 10 * 60 * 1000

export class MissingOAuthClientError extends Error {
  constructor() {
    super(
      'I do not have Google sign-in details yet. In Settings, add the OAuth client ID and ' +
        'secret from your Google Cloud project, then ask me to connect Gmail again.'
    )
    this.name = 'MissingOAuthClientError'
  }
}

async function clientCredentials(): Promise<{ clientId: string; clientSecret: string }> {
  // Build-time values win so a packaged build can ship ready to go; otherwise the user pastes
  // their own in Settings. A desktop client secret is not confidential per RFC 8252, but it is
  // still kept in the encrypted store rather than plain config.
  const clientId = process.env.IRIS_GOOGLE_CLIENT_ID ?? (await getSecret('googleClientId'))
  const clientSecret =
    process.env.IRIS_GOOGLE_CLIENT_SECRET ?? (await getSecret('googleClientSecret'))
  if (!clientId || !clientSecret) throw new MissingOAuthClientError()
  return { clientId, clientSecret }
}

export async function createOAuthClient(redirectUri?: string): Promise<OAuth2Client> {
  const { clientId, clientSecret } = await clientCredentials()
  return new OAuth2Client({ clientId, clientSecret, ...(redirectUri ? { redirectUri } : {}) })
}

function landingPage(heading: string, detail: string): string {
  // Rendered in the user's own browser, so it must stand on its own for a screen reader. The
  // role="status" heading is announced without the user having to hunt for it.
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${heading} — IRIS</title>
    <style>
      body { font-family: system-ui, sans-serif; background: #05070d; color: #dce8ff;
             display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 24px; }
      main { max-width: 34rem; text-align: center; }
      h1 { font-size: 1.6rem; line-height: 1.3; }
      p { color: #8399bd; font-size: 1.05rem; line-height: 1.6; }
    </style>
  </head>
  <body>
    <main>
      <h1 role="status" tabindex="-1" autofocus>${heading}</h1>
      <p>${detail}</p>
    </main>
  </body>
</html>`
}

export interface AuthResult {
  email: string
  refreshToken: string
}

/**
 * Loopback authorization code flow with PKCE, per RFC 8252. A BrowserWindow cannot be used:
 * Google returns `disallowed_useragent` for OAuth in embedded webviews, and spoofing the user
 * agent is both blocked and against policy. Using the system browser also means the user's own
 * screen reader, password manager, and existing Google session all work normally.
 */
export async function runGoogleAuthFlow(): Promise<AuthResult> {
  const { clientId, clientSecret } = await clientCredentials()
  const state = randomBytes(24).toString('base64url')

  const server = http.createServer()
  // Port 0 lets the OS choose. Google allows any port for loopback redirects, so no fixed port
  // needs reserving and two IRIS instances cannot collide.
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') resolve(address.port)
      else reject(new Error('Could not determine the local port for sign-in.'))
    })
  })

  const redirectUri = `http://127.0.0.1:${port}`
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri })
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync()

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: GMAIL_SCOPES,
    // Forces a refresh token even if this account has consented before.
    prompt: 'consent',
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
    state
  })

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Sign-in timed out. Ask me to connect Gmail again when you are ready.'))
    }, FLOW_TIMEOUT_MS)

    const finish = (error: Error | null, value?: string): void => {
      clearTimeout(timer)
      server.close()
      if (error) reject(error)
      else resolve(value!)
    }

    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', redirectUri)
      // Browsers request /favicon.ico unprompted; answering it would end the flow early.
      if (url.pathname !== '/') {
        response.writeHead(404).end()
        return
      }

      const respond = (status: number, heading: string, detail: string): void => {
        response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(landingPage(heading, detail))
      }

      const error = url.searchParams.get('error')
      if (error) {
        respond(400, 'Sign-in was cancelled', 'You can close this tab and return to IRIS.')
        finish(new Error(`Google reported: ${error}`))
        return
      }

      // Guards against a malicious page racing our loopback listener with its own code.
      if (url.searchParams.get('state') !== state) {
        respond(400, 'Sign-in could not be verified', 'Please close this tab and try again.')
        finish(new Error('OAuth state mismatch; sign-in was not completed.'))
        return
      }

      const value = url.searchParams.get('code')
      if (!value) {
        respond(400, 'Sign-in did not complete', 'Please close this tab and try again.')
        finish(new Error('Google did not return an authorization code.'))
        return
      }

      respond(
        200,
        'IRIS is connected to Gmail',
        'You can close this tab now. IRIS will tell you out loud when it is ready.'
      )
      finish(null, value)
    })

    log.info('opening system browser for Google sign-in')
    void shell.openExternal(authUrl).catch((cause) => finish(cause as Error))
  })

  // The docs describe client_secret as optional at the token endpoint for desktop clients, but
  // in practice Google rejects the exchange without it, so the client above always carries it.
  const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri })
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a long-lived token. Make sure the app’s publishing status is ' +
        '“In production” in the Google Cloud console, then try again.'
    )
  }

  client.setCredentials(tokens)
  const email = await fetchEmailAddress(client)

  await setSecret('googleRefreshToken', tokens.refresh_token)
  log.info(`connected Gmail account ${email}`)
  return { email, refreshToken: tokens.refresh_token }
}

async function fetchEmailAddress(client: OAuth2Client): Promise<string> {
  const { gmail } = await import('@googleapis/gmail')
  const api = gmail({ version: 'v1', auth: client })
  const profile = await api.users.getProfile({ userId: 'me' })
  return profile.data.emailAddress ?? 'your account'
}
