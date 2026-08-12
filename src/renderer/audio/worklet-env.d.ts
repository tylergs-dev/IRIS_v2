// AudioWorkletGlobalScope is not covered by lib.dom, and the worklet sources are global scripts
// (esbuild bundles each one standalone), so these globals are declared once here for both.

declare const sampleRate: number
declare const currentFrame: number
declare const currentTime: number

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor
): void
