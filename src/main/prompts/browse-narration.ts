/**
 * The browser skill asks a text model to choose one action at a time from the accessibility tree.
 * Refs (`[ref=e12]`) come straight from Playwright's AI-mode snapshot, so the model never has to
 * invent a CSS selector.
 */
export function nextActionPrompt(goal: string, url: string, snapshot: string, history: string[]): string {
  return [
    'You are operating a web browser on behalf of a blind user. Choose exactly one next action.',
    '',
    `Goal: ${goal}`,
    `Current page: ${url}`,
    '',
    history.length > 0 ? `Actions already taken:\n${history.map((h) => `- ${h}`).join('\n')}` : '',
    '',
    'The page as an accessibility tree, where [ref=eN] identifies an element:',
    '---',
    snapshot,
    '---',
    '',
    'Respond with a single JSON object and nothing else:',
    '{"action":"click","ref":"e12","why":"open the search results"}',
    '{"action":"type","ref":"e3","text":"denver weather","submit":true,"why":"search"}',
    '{"action":"navigate","url":"https://example.com","why":"go straight to the source"}',
    '{"action":"read","why":"the answer is on this page"}',
    '{"action":"give_up","why":"this needs a login"}',
    '',
    'Rules:',
    '- Prefer "read" as soon as the page plausibly contains the answer. Do not keep clicking to',
    '  refine something that is already good enough.',
    '- Never accept cookie banners by clicking "reject all" if that reloads the page; prefer',
    '  "accept" so the task can proceed.',
    '- Choose "give_up" for anything needing a login, a payment, a captcha, or a personal detail.',
    '- Never enter a password, a card number, an address, or any personal information.',
    '- "why" must be a short phrase in plain language, suitable to be read aloud.'
  ]
    .filter(Boolean)
    .join('\n')
}

export function pageAnswerPrompt(goal: string, url: string, text: string): string {
  return [
    `Answer this question using only the page below: ${goal}`,
    `The page is ${hostOf(url)}.`,
    '',
    'Three or four sentences of plain spoken prose. No markdown, no lists, no URLs. If the page',
    'does not actually answer the question, say so plainly rather than guessing. If it is a',
    'paywall, a login wall, or an error page, say only that.',
    '',
    'Page text:',
    '---',
    text.slice(0, 16_000),
    '---'
  ].join('\n')
}

/**
 * Turns a snapshot diff into something worth hearing. Whole snapshots are both a token sink and
 * unbearable read aloud, so only what changed is described, and only the interesting parts.
 */
export function describeSnapshotDiff(before: string, after: string, limit = 6): string {
  if (!before) return ''

  const previous = new Set(before.split('\n').map((line) => line.trim()))
  const added = after
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !previous.has(line))
    .map(cleanSnapshotLine)
    .filter((line): line is string => Boolean(line))

  if (added.length === 0) return ''
  const shown = added.slice(0, limit)
  const extra = added.length - shown.length
  return shown.join('; ') + (extra > 0 ? `, and ${extra} more` : '')
}

const INTERESTING =
  /^-?\s*(heading|link|button|listitem|paragraph|text|alert|status|textbox|searchbox|combobox)\b/i

/** A progress update is an aside, not a recitation, so a long paragraph gets clipped. */
const NARRATION_CHARS = 90

function cleanSnapshotLine(line: string): string | null {
  if (!INTERESTING.test(line)) return null
  const withoutRef = line
    .replace(/\s*\[ref=e\d+\]/g, '')
    .replace(/\s*\[(?:cursor=[^\]]+|active|level=\d+)\]/g, '')
    .replace(/^-\s*/, '')
  const named = withoutRef.match(/^(\w+)\s+"([^"]+)"/)
  if (named) return clip(`${named[1]} ${named[2]}`)
  const bare = withoutRef.match(/^(?:text|paragraph):\s*(.+)$/i)
  if (bare && bare[1].length > 3) return clip(bare[1].replace(/^"|"$/g, ''))
  return null
}

function clip(text: string): string {
  if (text.length <= NARRATION_CHARS) return text
  const cut = text.slice(0, NARRATION_CHARS)
  const boundary = cut.lastIndexOf(' ')
  return `${boundary > 40 ? cut.slice(0, boundary) : cut}…`
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
