import type { VoiceState } from '@shared/types'

const LABELS: Record<VoiceState, string> = {
  asleep: 'Asleep',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking'
}

export function StatusOrb({ state }: { state: VoiceState }): React.JSX.Element {
  return (
    <div className="orb" data-state={state} role="img" aria-label={`IRIS is ${LABELS[state]}`}>
      <span />
      <span />
      <span />
    </div>
  )
}

export function stateLabel(state: VoiceState): string {
  return LABELS[state]
}
