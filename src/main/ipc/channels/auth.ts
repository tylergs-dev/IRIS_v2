import { gmail } from '../../skills/email/GmailService'
import { handle } from '../register'

export function registerAuthChannels(): void {
  handle('auth:googleConnect', () => gmail.connect())
  handle('auth:googleDisconnect', () => gmail.disconnect())
  handle('auth:googleStatus', () => gmail.getAccount())
  handle('email:listLabels', () => gmail.listLabels())
}
