# IRIS

A voice-first assistant for a blind user, built around Gmail triage. IRIS is spoken to and answers
out loud. The daily user is not expected to run a screen reader; the window is for a sighted helper
at first install (API keys, Windows SmartScreen, Gmail sign-in) and as a readable mirror of what
was said. After that, nothing important is available only on screen.

## Requirements

- Node 22.12 or newer
- Windows 10/11 is the target platform. macOS and Linux run in development.
- Microsoft Edge or Google Chrome installed, for the browsing skill. Edge ships with Windows.

## Getting started

```bash
npm install
npm run models   # downloads the two shared wake word models
npm run dev
```

On first launch IRIS asks for a Gemini API key, then introduces itself and walks through setup by
voice. Keys are entered in Settings and stored with Electron's `safeStorage`, which encrypts them
against the OS user account.

| Key | Needed for | Where |
| --- | --- | --- |
| Gemini API key | All speech. IRIS cannot talk without it. | [aistudio.google.com](https://aistudio.google.com/apikey) |
| Tavily API key | Quick web search. Optional. | [tavily.com](https://tavily.com) |
| Google OAuth client | Gmail. Optional; a desktop client ID and secret. | Google Cloud Console |

For Gmail, create an OAuth client of type **Desktop app**, request only the `gmail.modify` scope,
and set the consent screen's publishing status to **In production**. Left in Testing, Google expires
the refresh token after seven days and IRIS would ask the user to sign in again every week.

## Giving IRIS to someone

First install is meant to be done with a sighted helper. They click through Windows SmartScreen,
paste the keys, and connect Gmail. The installer is **unsigned on purpose** — no Azure Trusted
Signing account or code-signing certificate is required. SmartScreen's "More info → Run anyway"
dialog appears once, on that first Setup exe; a helper can dismiss it. Later updates do not go
through SmartScreen again.

The daily user talks to IRIS. They do not need NVDA, JAWS, or Narrator.

### Over-the-air updates

A packaged install checks a HTTPS feed on launch, downloads quietly, and offers the update out
loud. Applying it restarts IRIS and does not need the helper. This still works without code
signing: Velopack replaces files inside the already-installed app.

The Node binding talks to a **static HTTPS folder** (not GitHub Releases' API). Pick a public URL
first, then bake it into the build — an installed copy cannot be pointed at a feed later.

```bash
npm install
npm run models
$env:IRIS_UPDATE_FEED = "https://example.com/iris/"   # must already be the public folder URL
npm run release:win
```

Upload the whole `Releases/` directory (installer, `.nupkg` files, `releases.win.json`) to that
URL. GitHub Pages, Cloudflare R2, or an S3 bucket all work; the host must serve a complete TLS
certificate chain, because Velopack uses bundled webpki roots rather than the Windows trust store.

Give the helper the Setup exe from that folder. To ship a newer version: bump `version` in
`package.json`, run `release:win` with the **same** `IRIS_UPDATE_FEED`, and upload `Releases/`
again, keeping older `.nupkg` files so delta updates still resolve.

Signing remains optional. If you later set `IRIS_AZURE_SIGN_FILE`, vpk will Authenticode-sign the
bootstrapper; it is not needed for this product.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Development with hot reload |
| `npm run build` | Typecheck, then bundle main, preload, and renderer |
| `npm run typecheck` | Both TypeScript projects, no emit |
| `npm run lint` | ESLint, type-aware |
| `npm run models` | Fetch the shared wake word models into `models/` |
| `npm run pack:win` | Unpacked Windows build |
| `npm run release:win` | Windows build plus a Velopack installer and update feed |

## Wake word

Saying "hey IRIS" wakes it. Ctrl+Shift+I does the same and always works, including when another
window has focus, so the wake word is a convenience rather than the way in.

Detection is [livekit-wakeword](https://github.com/livekit/livekit-wakeword)'s three-stage pipeline
running locally through `onnxruntime-node`: a mel-spectrogram model, a shared speech embedding
model, and a small conv-attention classifier trained on one phrase. Audio never leaves the machine
unless IRIS is awake, and a loudness gate means silence costs nothing. `npm run models` fetches the
first two. The third, `models/iris.onnx`, is trained with livekit-wakeword and committed with the
app. Without any of the three, the wake word is simply off — IRIS logs that once and carries on.

To retrain it, install livekit-wakeword and run its pipeline with the target phrase "hey iris",
then replace `models/iris.onnx` with the exported classifier. PCM is scaled to [-1, 1] before the
mel model, matching how livekit-wakeword trains; feeding int16-scale floats will silently prevent
the classifier from firing.

Two things matter more than accuracy on a held-out set:

- **Tune for a low false-accept rate, not a low false-reject rate.** A missed wake word costs one
  repetition. A false one means IRIS starts listening and talking in a room where nobody addressed
  it — which a blind user cannot see happen and cannot easily attribute. Measure against hours of
  television and podcast audio, not against clean recordings.
- **Train a single-speaker verifier on the actual user's voice** if you can. It cuts false accepts
  sharply for one specific person, which is exactly the situation here.

## Architecture

```
src/main       Electron main process — owns the Gemini Live session, Gmail, skills, and secrets
src/preload    contextBridge surface; the only channel between the two worlds
src/renderer   React UI, and the AudioWorklets that capture and play audio
src/shared     Types shared across the boundary, including the IPC contract
```

The renderer holds no keys and makes no network calls. It captures microphone audio, plays what
comes back, and renders state. Everything else — the model session, the Gmail client, tool
execution — lives in main, behind a typed IPC contract that validates every sender.

Voice runs on Gemini Live over a persistent bidirectional stream: 16 kHz PCM up, 24 kHz PCM down
through a ring buffer, with barge-in handled by a generation counter so that interrupting IRIS
stops it immediately rather than after the buffer drains. Sessions resume across reconnects, so a
dropped network does not lose the conversation.

Skills are exposed to the model as tools. Long-running ones — browsing, in particular — return
immediately and narrate their progress as it happens, because several seconds of silence is
indistinguishable from a crash when you cannot see a spinner.

## Voice-first design

The window is a mirror, not the interface. The intended user does not run a screen reader, so
anything that only appears on screen has not been delivered to them. Every action the window
offers can also be asked for out loud, and every failure is explained in plain words rather than
surfaced as an error code. Deleting an email moves it to Trash and can always be undone by saying
so.

**IRIS has to say it.** A warning that is merely drawn has not been delivered. That includes
failures IRIS cannot see: if the microphone opens but delivers digital silence — a hardware mute
switch, or Windows blocking microphone access — that is detected and said aloud, because
`getUserMedia` reports it as success.

When voice itself is down (no Gemini key, or the live session cannot start), the window is the
backup for whoever is sitting with them — typically the same helper who installed it. There is no
screen-reader fallback, and verifying NVDA or JAWS is not part of shipping this.

The helper-only exceptions are the steps that cannot be spoken reliably: the two API keys (long
random strings, and IRIS will not read a credential aloud in a room), Windows SmartScreen on first
install, and Google's OAuth consent screens. Connecting Gmail after that can be asked for, but the
browser still needs the helper.

When something is unavailable, IRIS says so and offers the next best thing rather than stopping:
quick search failing becomes an offer to browse instead, and an unreachable Gmail still reads the
inbox as it was at the last successful fetch, while refusing to pretend it can delete or file
anything.
