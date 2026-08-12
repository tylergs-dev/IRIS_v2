import { Type } from '@google/genai'
import { registerTool } from '../../voice/tools'
import { updates } from '../../update/UpdateService'
import { handle } from '../register'

export function registerUpdateChannels(): void {
  handle('update:check', () => updates.checkQuietly())
  handle('update:applyNow', () => {
    updates.applyNow()
  })

  registerTool({
    declaration: {
      name: 'install_update',
      description:
        'Install the update that has already been downloaded. This closes and reopens IRIS, so ' +
        'say one short sentence telling them you will be back in a moment before calling it. ' +
        'Only ever call this after they have agreed.',
      parameters: { type: Type.OBJECT, properties: {} }
    },
    handler: async () => {
      const version = updates.pendingVersion()
      if (!updates.applyNow()) {
        return { error: 'There is no downloaded update to install. Say so plainly.' }
      }
      return { installing: true, version }
    }
  })

  registerTool({
    declaration: {
      name: 'postpone_update',
      description:
        'Record that the user does not want to install the update now. It will be installed on ' +
        'its own at some later restart, and they will not be asked again for several days.',
      parameters: { type: Type.OBJECT, properties: {} }
    },
    handler: async () => {
      updates.postpone()
      return {
        postponed: true,
        note:
          'Acknowledge in a few words. Reassure them it will happen quietly later and that ' +
          'nothing is wrong. Then drop the subject.'
      }
    }
  })
}
