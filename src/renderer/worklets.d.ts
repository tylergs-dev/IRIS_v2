// Resolved by build/vite-plugin-audio-worklet.ts, which bundles the worklet separately and
// returns the URL to hand to `audioWorklet.addModule()`.
declare module '*?worklet-url' {
  const url: string
  export default url
}
