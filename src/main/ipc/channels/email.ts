import { classifyEmailUtterance, emailMode } from '../../skills/SkillOrchestrator'
import { listArticles, removeArticle } from '../../storage/reading-list'
import { emit, handle } from '../register'

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

  handle('email:undoLast', () => emailMode.undoLast())
  handle('email:getSnapshot', () => emailMode.snapshot())

  handle('reading:list', () => listArticles())
  handle('reading:remove', (id) => removeArticle(id))
}
