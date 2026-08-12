type Level = 'debug' | 'info' | 'warn' | 'error'

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = order[(process.env.IRIS_LOG_LEVEL as Level) ?? 'info'] ?? order.info

function emit(level: Level, scope: string, message: string, extra?: unknown): void {
  if (order[level] < threshold) return
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${scope} ${message}`
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  if (extra === undefined) sink(line)
  else sink(line, extra)
}

export interface Logger {
  debug(message: string, extra?: unknown): void
  info(message: string, extra?: unknown): void
  warn(message: string, extra?: unknown): void
  error(message: string, extra?: unknown): void
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e)
  }
}
