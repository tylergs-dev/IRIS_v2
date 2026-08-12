import type { EmailLink, SavedArticle } from '../../shared/types'

/**
 * Asks the model to pick out real article links from a newsletter's anchors. The heuristic filter
 * in digest-detect.ts has already removed the obvious junk; this catches what patterns cannot,
 * such as a sponsored placement written to look editorial.
 */
export function articleExtractionPrompt(links: EmailLink[], senderName: string): string {
  return [
    `You are looking at the links from a newsletter sent by ${senderName}.`,
    '',
    'Return only the links that are genuine articles a reader would want to read. Exclude',
    'advertisements and sponsored placements, unsubscribe and preference links, social media',
    'links, "view in browser" links, links to the publication’s home page or section index, and',
    'app store or subscription upsells.',
    '',
    'Rewrite each title as a person would say it aloud: expand abbreviations, drop trailing site',
    'names, and remove all-caps shouting. Keep the meaning exactly.',
    '',
    'Respond with a JSON array of objects with "title" and "href". No prose, no code fences.',
    'If none of the links are articles, respond with an empty array.',
    '',
    'Links:',
    ...links.map((link, index) => `${index + 1}. ${link.text || '(no text)'} -> ${link.href}`)
  ].join('\n')
}

/** Cue for reading one article title during Article Review Mode. */
export function articleAnnouncement(title: string, index: number, total: number): string {
  return (
    `Article ${index} of ${total}: "${title}". Read the title exactly as written, then ask ` +
    'whether they want to save it, hear about it, or skip to the next one. Keep it to one short ' +
    'question.'
  )
}

export function articleSummaryPrompt(title: string, text: string): string {
  return [
    `Summarize this article for a blind listener in three or four sentences. The title is "${title}".`,
    '',
    'Plain spoken prose only. No markdown, no lists, no URLs. Lead with the substance rather than',
    'describing the article. If the page turned out to be a paywall, a login screen, or an error,',
    'say only that.',
    '',
    'Article text:',
    '---',
    text.slice(0, 16_000),
    '---'
  ].join('\n')
}

export function readingListAnnouncement(articles: SavedArticle[]): string {
  if (articles.length === 0) {
    return 'The reading list is empty. Tell the user there is nothing saved yet.'
  }
  return [
    `The user has ${articles.length} saved article${articles.length === 1 ? '' : 's'}.`,
    'Read the titles aloud, numbered, exactly as written. Then ask which one they want to hear.',
    '',
    ...articles.map((article, index) => `${index + 1}. ${article.title} (from ${article.sourceSender})`)
  ].join('\n')
}
