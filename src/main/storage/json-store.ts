import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createLogger } from '../log'

const log = createLogger('json-store')

/**
 * Small atomic JSON store for non-secret state. Writes go to a temp file and are renamed, so a
 * crash mid-write cannot leave a truncated file. Reads are synchronous and cached because
 * callers (the persona prompt, the email machine) need the profile inline.
 *
 * Deliberately not electron-store: it is ESM-only, and this main process is CommonJS because
 * sandboxed preloads and the native addons in later phases require CJS.
 */
export class JsonStore<T extends object> {
  private cache: T | null = null
  private readonly file: string
  private queue: Promise<void> = Promise.resolve()

  constructor(
    name: string,
    private readonly defaults: T
  ) {
    this.file = path.join(app.getPath('userData'), `${name}.json`)
  }

  get path(): string {
    return this.file
  }

  get(): T {
    if (this.cache) return this.cache
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      this.cache = { ...this.defaults, ...(JSON.parse(raw) as Partial<T>) }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') log.warn(`could not read ${this.file}; using defaults`, error)
      this.cache = { ...this.defaults }
    }
    return this.cache
  }

  set(patch: Partial<T>): T {
    const next = { ...this.get(), ...patch }
    this.cache = next
    this.flush(next)
    return next
  }

  replace(value: T): T {
    this.cache = value
    this.flush(value)
    return value
  }

  /** Serialized so concurrent writes cannot interleave temp files onto the same target. */
  private flush(value: T): void {
    this.queue = this.queue.then(async () => {
      const tmp = `${this.file}.${randomUUID()}.tmp`
      try {
        await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
        await fsp.rename(tmp, this.file)
      } catch (error) {
        log.error(`failed to persist ${this.file}`, error)
        await fsp.rm(tmp, { force: true }).catch(() => undefined)
      }
    })
  }

  /** Awaits pending writes. Used on quit so nothing is lost. */
  async settled(): Promise<void> {
    await this.queue
  }
}
