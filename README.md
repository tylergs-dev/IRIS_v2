# IRIS

A voice-first assistant for blind and low-vision users, built around Gmail triage. IRIS is spoken
to and answers out loud; the window exists so that a sighted helper can set up keys and so that
everything spoken is also readable, but nothing important is available only on screen.

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

## Accessibility

The window is a mirror, not the interface. Every action it offers can also be asked for out loud,
and every failure is explained in plain words rather than surfaced as an error code. Deleting an
email moves it to Trash and can always be undone by saying so.

Two rules shape most of the design:

**Nothing important is delivered only on screen.** A warning that is merely drawn has not been
delivered. Every notice is either spoken by IRIS in its own voice or, when voice is the thing that
is broken, handed to the screen reader through an assertive live region. There is no third path,
including for failures IRIS cannot see: if the microphone opens but delivers digital silence — a
hardware mute switch, or Windows blocking microphone access — that is detected and said aloud,
because `getUserMedia` reports it as success.

**IRIS and the screen reader must not talk at once.** The conversation transcript is deliberately
*not* an ARIA live region. Every line in it has already been spoken, so announcing it again means
two voices over each other, and because transcripts stream in token by token a live region would
re-announce each sentence as it grew. Only what IRIS does not say aloud is announced — the voice
state, debounced so that waking, which passes through three states in about a second, produces one
announcement rather than three.

The two API keys are the deliberate exception to spoken parity. They are long random strings that
cannot be dictated reliably, and IRIS will not read a credential aloud in a room. Everything else,
including connecting Gmail, is reachable by asking.

When something is unavailable, IRIS says so and offers the next best thing rather than stopping:
quick search failing becomes an offer to browse instead, and an unreachable Gmail still reads the
inbox as it was at the last successful fetch, while refusing to pretend it can delete or file
anything.

### Screen reader verification

**Not yet done, and it needs a Windows machine.** The design decisions above were made against how
NVDA and JAWS behave, but behaviour and intent are different things and this is the one part that
cannot be verified by reasoning. Both screen readers also duck other applications' audio while
speaking, so IRIS's own voice will drop in volume whenever they talk — the mitigation is keeping
them from speaking at the same time in the first place, which is what the live region rules above
are for, but the result needs hearing.

What to check, with NVDA and then JAWS running:

- Waking IRIS announces the settled state once, not once per intermediate state.
- A full exchange produces no duplicate reading of the transcript over IRIS's own speech.
- IRIS's voice remains clearly audible while the screen reader is also speaking.
- Unplugging the network mid-conversation is announced out loud, not silently.
- With no Gemini API key, the first-run banner is reached and read by keyboard alone.
- Muting the microphone at the hardware switch is announced within about ten seconds.
- Tab, Shift+Tab, and Escape reach and operate every control, with a visible focus ring.
- Windows high contrast mode leaves the service status and notice severity distinguishable.
