/**
 * The prebuilt voices the Live API accepts in `speechConfig`. Google's own one-word
 * characterisations are kept alongside each name because the names by themselves
 * ("Zubenelgenubi") tell a listener nothing about what they are picking, and the person choosing
 * is usually hearing this list rather than reading it.
 *
 * Listed alphabetically so a screen reader's type-ahead lands somewhere predictable.
 */
export const LIVE_VOICES = [
  { name: 'Achernar', description: 'soft' },
  { name: 'Achird', description: 'friendly' },
  { name: 'Algenib', description: 'gravelly' },
  { name: 'Algieba', description: 'smooth' },
  { name: 'Alnilam', description: 'firm' },
  { name: 'Aoede', description: 'breezy' },
  { name: 'Autonoe', description: 'bright' },
  { name: 'Callirrhoe', description: 'easy-going' },
  { name: 'Charon', description: 'informative' },
  { name: 'Despina', description: 'smooth' },
  { name: 'Enceladus', description: 'breathy' },
  { name: 'Erinome', description: 'clear' },
  { name: 'Fenrir', description: 'excitable' },
  { name: 'Gacrux', description: 'mature' },
  { name: 'Iapetus', description: 'clear' },
  { name: 'Kore', description: 'firm' },
  { name: 'Laomedeia', description: 'upbeat' },
  { name: 'Leda', description: 'youthful' },
  { name: 'Orus', description: 'firm' },
  { name: 'Puck', description: 'upbeat' },
  { name: 'Pulcherrima', description: 'forward' },
  { name: 'Rasalgethi', description: 'informative' },
  { name: 'Sadachbia', description: 'lively' },
  { name: 'Sadaltager', description: 'knowledgeable' },
  { name: 'Schedar', description: 'even' },
  { name: 'Sulafat', description: 'warm' },
  { name: 'Umbriel', description: 'easy-going' },
  { name: 'Vindemiatrix', description: 'gentle' },
  { name: 'Zephyr', description: 'bright' },
  { name: 'Zubenelgenubi', description: 'casual' }
] as const

export type VoiceName = (typeof LIVE_VOICES)[number]['name']

/** What the Live API uses when no voice is given, so upgrading a profile changes nothing. */
export const DEFAULT_VOICE: VoiceName = 'Puck'

export const VOICE_NAMES: VoiceName[] = LIVE_VOICES.map((voice) => voice.name)

export function isVoiceName(value: unknown): value is VoiceName {
  return typeof value === 'string' && (VOICE_NAMES as string[]).includes(value)
}

/** "Sulafat, a warm voice" — for reading a choice back to someone who cannot see the list. */
export function describeVoice(name: VoiceName): string {
  const match = LIVE_VOICES.find((voice) => voice.name === name)
  return match ? `${match.name}, a ${match.description} voice` : name
}
