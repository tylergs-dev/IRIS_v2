import { JsonStore } from '../../storage/json-store'

interface TrashEntry {
  kind: 'trash'
  messageId: string
  description: string
}

interface LabelEntry {
  kind: 'label'
  messageId: string
  addedLabelId: string
  description: string
}

export type UndoEntry = TrashEntry | LabelEntry

interface UndoFile {
  entries: UndoEntry[]
}

const MAX_ENTRIES = 20

/**
 * Backs "undo that" without ever asking for confirmation up front. Persisted because the user may
 * close IRIS and only later realise they deleted the wrong thing — and because trashed mail stays
 * recoverable for thirty days, well beyond one session.
 */
class UndoStack {
  private store: JsonStore<UndoFile> | null = null

  private getStore(): JsonStore<UndoFile> {
    this.store ??= new JsonStore<UndoFile>('email-undo', { entries: [] })
    return this.store
  }

  private entries(): UndoEntry[] {
    return this.getStore().get().entries
  }

  push(entry: UndoEntry): void {
    this.getStore().set({ entries: [entry, ...this.entries()].slice(0, MAX_ENTRIES) })
  }

  peek(): UndoEntry | undefined {
    return this.entries()[0]
  }

  pop(): UndoEntry | undefined {
    const [head, ...rest] = this.entries()
    if (head) this.getStore().set({ entries: rest })
    return head
  }

  canUndo(): boolean {
    return this.entries().length > 0
  }

  async settled(): Promise<void> {
    await this.store?.settled()
  }
}

export const undoStack = new UndoStack()
