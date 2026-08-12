import { randomUUID } from 'node:crypto'
import type { SavedArticle } from '../../shared/types'
import { emit } from '../ipc/register'
import { JsonStore } from './json-store'

interface ReadingListFile {
  articles: SavedArticle[]
}

const MAX_ARTICLES = 200

let store: JsonStore<ReadingListFile> | null = null

function getStore(): JsonStore<ReadingListFile> {
  store ??= new JsonStore<ReadingListFile>('reading-list', { articles: [] })
  return store
}

export function listArticles(): SavedArticle[] {
  return getStore().get().articles
}

export function saveArticle(input: Omit<SavedArticle, 'id' | 'savedAt'>): SavedArticle {
  const articles = listArticles()

  // Saving the same article twice is a normal thing to do by voice; treat it as idempotent
  // rather than growing a list of duplicates.
  const existing = articles.find((article) => article.href === input.href)
  if (existing) return existing

  const article: SavedArticle = { ...input, id: randomUUID(), savedAt: Date.now() }
  const next = [article, ...articles].slice(0, MAX_ARTICLES)
  getStore().set({ articles: next })
  emit('reading:changed', next)
  return article
}

export function removeArticle(id: string): void {
  const next = listArticles().filter((article) => article.id !== id)
  getStore().set({ articles: next })
  emit('reading:changed', next)
}

export async function flushReadingList(): Promise<void> {
  await store?.settled()
}
