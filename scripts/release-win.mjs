#!/usr/bin/env node
/**
 * Packages a Windows release: electron-builder produces an unpacked directory, then Velopack's
 * `vpk` turns it into an installer plus a delta-capable release feed.
 *
 * Run on Windows. Requires the .NET SDK and a version-matched vpk:
 *   dotnet tool install -g vpk --version <the velopack version in package.json>
 * A mismatch between vpk and the npm package produces packages the runtime cannot read.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

const PACK_ID = 'IRIS'
const PACK_TITLE = 'IRIS'
const PACK_DIR = path.join(root, 'release', 'win-unpacked')
const OUT_DIR = path.join(root, 'Releases')
const MAIN_EXE = 'IRIS.exe'

function fail(message) {
  console.error(`\n${message}\n`)
  process.exit(1)
}

if (process.platform !== 'win32') {
  fail(
    'Windows only. electron-builder cannot produce a Windows binary from this platform, and vpk ' +
      'needs the Windows toolchain to build the bootstrapper.'
  )
}

let vpkVersion
try {
  vpkVersion = execFileSync('vpk', ['--version'], { encoding: 'utf8' }).trim()
} catch {
  fail(
    'vpk was not found. Install the .NET SDK, then:\n' +
      `  dotnet tool install -g vpk --version ${pkg.dependencies.velopack}`
  )
}

// The npm binding and the CLI share a release cadence and a package format; drift between them is
// the kind of failure that only shows up on the user's machine, at update time.
if (!vpkVersion.startsWith(pkg.dependencies.velopack)) {
  console.warn(
    `\nWARNING: vpk is ${vpkVersion} but velopack in package.json is ` +
      `${pkg.dependencies.velopack}. These must match.\n`
  )
}

if (!existsSync(PACK_DIR)) {
  fail(`Nothing to package: ${PACK_DIR} does not exist. Run "npm run pack:win" first.`)
}
if (!existsSync(path.join(PACK_DIR, MAIN_EXE))) {
  fail(`${MAIN_EXE} is missing from ${PACK_DIR}. Check productName in electron-builder.yml.`)
}

const args = [
  'pack',
  '--packId', PACK_ID,
  '--packTitle', PACK_TITLE,
  '--packVersion', pkg.version,
  '--packAuthors', pkg.author ?? PACK_TITLE,
  '--packDir', PACK_DIR,
  '--mainExe', MAIN_EXE,
  '--outputDir', OUT_DIR
]

/**
 * Unsigned is the intended default. First install is done with a sighted helper, who clicks
 * through SmartScreen once. Later Velopack updates replace files inside the install directory and
 * do not hit that dialog. Signing remains optional if a certificate later exists: pass it to vpk
 * rather than only to electron-builder, because Velopack ships its own bootstrap binaries.
 */
if (process.env.IRIS_AZURE_SIGN_FILE) {
  if (!existsSync(process.env.IRIS_AZURE_SIGN_FILE)) {
    fail(`IRIS_AZURE_SIGN_FILE points at a file that does not exist.`)
  }
  args.push('--azureTrustedSignFile', process.env.IRIS_AZURE_SIGN_FILE)
} else {
  console.warn(
    '\nBuilding unsigned (expected). SmartScreen will warn once on first install; a helper ' +
      'clicks through it. Set IRIS_AZURE_SIGN_FILE only if you want a signed build.\n'
  )
}

console.log(`\nvpk ${args.join(' ')}\n`)
const result = spawnSync('vpk', args, { stdio: 'inherit', shell: false })
if (result.status !== 0) fail(`vpk exited with ${result.status ?? 'a signal'}.`)

console.log(
  [
    '',
    `Done. ${OUT_DIR} now holds the installer, the .nupkg, and releases.win.json.`,
    '',
    'To publish: upload the whole directory to the HTTPS folder that IRIS_UPDATE_FEED already',
    'pointed at during this build. Plain HTTP is not an option — applying an update is code',
    'execution. Code signing is not required for updates to work.',
    '',
    'Then verify from a clean Windows machine, not the build machine:',
    '  1. Install from the Setup exe (helper clicks through SmartScreen) and confirm IRIS speaks.',
    '  2. Bump the version, repackage with the same IRIS_UPDATE_FEED, upload, and relaunch.',
    '  3. Confirm the update is found, downloaded, and offered out loud.',
    '',
    'If the check fails with "invalid peer certificate: UnknownIssuer", that is a real TLS',
    'problem, not a bundler one: Velopack\'s HTTP client is compiled Rust using bundled webpki',
    'roots and ignores the OS trust store, so a corporate TLS intercept or an incomplete',
    'certificate chain on the host will fail here while a browser succeeds. Fix the chain or the',
    'host.',
    ''
  ].join('\n')
)
