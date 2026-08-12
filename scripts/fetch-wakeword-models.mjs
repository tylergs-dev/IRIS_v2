#!/usr/bin/env node
/**
 * Downloads the two shared openWakeWord feature models into `models/`.
 *
 * These are generic and identical for every wake word: a melspectrogram front end and a speech
 * embedding model. The third model — the small classifier that actually recognises "hey iris" —
 * cannot be downloaded, because it does not exist until it is trained. See the notes printed at
 * the end for how to produce it.
 *
 * They are fetched rather than committed so the repository stays free of binaries, and IRIS runs
 * perfectly well without them: the wake word is simply unavailable and the hotkey is used instead.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'

const RELEASE = 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1'
const FILES = ['melspectrogram.onnx', 'embedding_model.onnx']
const CLASSIFIER = 'hey_iris.onnx'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'models')
mkdirSync(outDir, { recursive: true })

for (const file of FILES) {
  const target = path.join(outDir, file)
  if (existsSync(target)) {
    console.log(`${file}: already present (${(statSync(target).size / 1e6).toFixed(1)} MB)`)
    continue
  }

  process.stdout.write(`${file}: downloading… `)
  const response = await fetch(`${RELEASE}/${file}`, { redirect: 'follow' })
  if (!response.ok) {
    console.error(`\nFailed: ${response.status} ${response.statusText}`)
    process.exit(1)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  writeFileSync(target, bytes)
  // Printed so a later download can be compared against a known-good copy.
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  console.log(`${(bytes.length / 1e6).toFixed(1)} MB, sha256 ${digest}…`)
}

if (existsSync(path.join(outDir, CLASSIFIER))) {
  console.log(`\n${CLASSIFIER} is present — the wake word will be active.`)
} else {
  console.log(
    [
      '',
      `${CLASSIFIER} is missing, so "hey iris" is inactive and the hotkey is the way to wake IRIS.`,
      '',
      'To produce it, run openWakeWord\'s automatic training notebook in Google Colab with the',
      'target phrase "hey iris". Training is Linux-only, and the notebook\'s pinned dependencies',
      'have gone stale since its last release in February 2024, so budget time for fixing the',
      'environment before any training starts.',
      '',
      `Rename the resulting .onnx model to ${CLASSIFIER} and put it in models/.`,
      '',
      'Two things matter more than accuracy on a held-out set:',
      '  - Tune for a low false-accept rate, not a low false-reject rate. A missed wake word costs',
      '    one repetition. A false one means IRIS starts listening in a room where nobody spoke to',
      '    it, which a blind user cannot see happen. Measure against hours of television and',
      '    podcast audio, not against clean recordings.',
      '  - Train a single-speaker verifier model on the actual user\'s voice if possible. It cuts',
      '    false accepts sharply for one specific person, which is exactly this situation.',
      ''
    ].join('\n')
  )
}
