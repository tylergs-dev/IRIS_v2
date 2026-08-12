import { notice } from '../../notify'
import { handle, listen } from '../register'
import { voice } from '../../voice/VoiceSessionManager'
import { registerCoreTools } from '../../voice/tools'
import { wakeWord } from '../../wake/WakeWordDetector'

export function registerVoiceChannels(): void {
  registerCoreTools({ sleep: () => voice.sleep(), cost: () => voice.getCostEstimate() })

  handle('voice:micProblem', async (message) => {
    // Woken deliberately: this is the one failure where saying it out loud requires the very
    // session the user was about to talk into, and they cannot be left waiting in silence.
    await voice.wake()
    notice('error', message)
  })

  handle('voice:wake', async () => {
    await voice.wake()
  })
  handle('voice:sleep', () => voice.sleep())
  handle('voice:stop', () => voice.stop())
  handle('voice:sendText', (text) => voice.sendText(text))
  handle('voice:getState', () => voice.getState())
  handle('voice:getCost', () => voice.getCostEstimate())
  handle('voice:speechActivity', (speaking) => voice.setSpeechActivity(speaking))

  // `send` rather than `invoke`: this fires every 80 ms and needs no reply.
  listen('voice:audioChunk', (pcm) => {
    // While asleep the audio goes only to the local wake word detector. It never reaches the Live
    // session, which is disconnected — nothing is uploaded until IRIS has actually been woken.
    if (voice.getState() === 'asleep') void wakeWord.push(pcm)
    else voice.pushAudio(pcm)
  })
}
