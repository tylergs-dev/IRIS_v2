import { basename } from 'node:path'
import { build as esbuild } from 'esbuild'
import type { Plugin } from 'vite'

const SUFFIX = '?worklet-url'
const OUT_DIR = 'worklets'

/**
 * AudioWorklet modules run in a global scope with no bundler support, so they cannot be
 * part of the normal renderer chunk graph. This bundles each `*.worklet.ts` separately
 * with esbuild and exposes a URL string to import, served from `/worklets/<name>.js` in
 * both dev and production.
 */
export function audioWorklet(): Plugin {
  const sources = new Map<string, string>()

  async function bundle(file: string): Promise<string> {
    const result = await esbuild({
      entryPoints: [file],
      bundle: true,
      write: false,
      format: 'iife',
      target: 'chrome130',
      platform: 'browser',
      logLevel: 'silent'
    })
    return result.outputFiles[0].text
  }

  return {
    name: 'iris:audio-worklet',
    enforce: 'pre',

    async resolveId(source, importer) {
      if (!source.endsWith(SUFFIX)) return null
      const resolved = await this.resolve(source.slice(0, -SUFFIX.length), importer, {
        skipSelf: true
      })
      if (!resolved) return null
      return `\0worklet:${resolved.id}`
    },

    async load(id) {
      if (!id.startsWith('\0worklet:')) return null
      const file = id.slice('\0worklet:'.length)
      const name = basename(file).replace(/\.worklet\.ts$/, '.js')

      sources.set(name, file)
      this.addWatchFile(file)

      if (this.meta.watchMode) {
        return `export default ${JSON.stringify(`${OUT_DIR}/${name}`)}`
      }

      this.emitFile({
        type: 'asset',
        fileName: `${OUT_DIR}/${name}`,
        source: await bundle(file)
      })
      return `export default ${JSON.stringify(`${OUT_DIR}/${name}`)}`
    },

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const match = req.url?.match(new RegExp(`^/${OUT_DIR}/([^?]+\\.js)`))
        if (!match) return next()
        const file = sources.get(match[1])
        if (!file) return next()
        try {
          res.setHeader('Content-Type', 'text/javascript')
          res.setHeader('Cache-Control', 'no-store')
          res.end(await bundle(file))
        } catch (error) {
          next(error)
        }
      })
    }
  }
}
