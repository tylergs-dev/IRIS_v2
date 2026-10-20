import type { EmailUiAction } from '../../../shared/types'
import { classifyEmailUtterance, emailMode, runEmailUiAction } from '../../skills/SkillOrchestrator'
import { clearArticles, listArticles, removeArticle } from '../../storage/reading-list'
import { emit, handle } from '../register'

/** Only these four reach the screen; anything else is a programming error, not user input. */
const UI_ACTIONS: ReadonlySet<EmailUiAction> = new Set(['readMore', 'next', 'delete', 'stop'])

export function registerEmailChannels(): void {
  handle('email:start', async () => {
    await emailMode.start()
    emit('email:snapshot', emailMode.snapshot())
  })

  handle('email:choose', async (utterance) => {
    const action = classifyEmailUtterance(utterance)
    if (!action) return
    await emailMode.handle(action)
    emit('email:snapshot', emailMode.snapshot())
  })

  handle('email:action', async (action) => {
    if (!UI_ACTIONS.has(action)) throw new Error(`Unknown email action: ${String(action)}`)
    const result = await runEmailUiAction({ type: action })
    emit('email:snapshot', emailMode.snapshot())
    return result
  })

  handle('email:undoLast', () => emailMode.undoLast())
  handle('email:getSnapshot', () => emailMode.snapshot())

  handle('reading:list', () => listArticles())
  handle('reading:remove', (id) => removeArticle(id))
  handle('reading:removeAll', () => clearArticles())
}
