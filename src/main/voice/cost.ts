import { MediaModality, type UsageMetadata } from '@google/genai'
import type { CostEstimate } from '../../shared/types'

/**
 * List prices per million tokens for gemini-3.1-flash-live-preview. Rough by design — the point
 * is to make a long session's cost visible rather than to bill accurately, because the Live API
 * reprocesses accumulated audio context every turn and real spend grows faster than wall time.
 */
const USD_PER_MILLION = {
  audioIn: 3,
  audioOut: 12,
  textIn: 0.75,
  textOut: 4.5
} as const

/** Audio accrues at roughly 25 tokens per second in both directions. */
const TOKENS_PER_AUDIO_SECOND = 25

export class CostTracker {
  private audioInTokens = 0
  private audioOutTokens = 0
  private textInTokens = 0
  private textOutTokens = 0
  private startedAt: number | null = null

  start(): void {
    this.startedAt ??= Date.now()
  }

  reset(): void {
    this.audioInTokens = 0
    this.audioOutTokens = 0
    this.textInTokens = 0
    this.textOutTokens = 0
    this.startedAt = null
  }

  record(usage: UsageMetadata): void {
    this.start()
    for (const detail of usage.promptTokensDetails ?? []) {
      if (detail.modality === MediaModality.AUDIO) this.audioInTokens += detail.tokenCount ?? 0
      else this.textInTokens += detail.tokenCount ?? 0
    }
    for (const detail of usage.responseTokensDetails ?? []) {
      if (detail.modality === MediaModality.AUDIO) this.audioOutTokens += detail.tokenCount ?? 0
      else this.textOutTokens += detail.tokenCount ?? 0
    }
    // Thinking is billed at the text output rate and is not itemised by modality.
    this.textOutTokens += usage.thoughtsTokenCount ?? 0
  }

  snapshot(): CostEstimate {
    const usd =
      (this.audioInTokens / 1e6) * USD_PER_MILLION.audioIn +
      (this.audioOutTokens / 1e6) * USD_PER_MILLION.audioOut +
      (this.textInTokens / 1e6) * USD_PER_MILLION.textIn +
      (this.textOutTokens / 1e6) * USD_PER_MILLION.textOut

    return {
      sessionSeconds: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      audioInSeconds: Math.round(this.audioInTokens / TOKENS_PER_AUDIO_SECOND),
      audioOutSeconds: Math.round(this.audioOutTokens / TOKENS_PER_AUDIO_SECOND),
      estimatedUsd: usd
    }
  }
}
