import type { EmailHeader, SummaryLength, UserProfile } from '../../shared/types'

const LENGTH_GUIDANCE: Record<SummaryLength, string> = {
  short: 'Keep it to two or three sentences. Lead with what it is actually asking of them.',
  detailed:
    'Use up to six sentences. Cover what it is asking, any dates or amounts, and who sent it.'
}

/**
 * Summarization prompt. Deliberately not a Live-API call — this runs as an ordinary generateContent
 * request so the model can take its time without blocking the conversation.
 */
export function emailSummaryPrompt(
  header: EmailHeader,
  body: string,
  profile: UserProfile
): string {
  return [
    'You are summarizing one email so it can be read aloud to a blind listener.',
    '',
    LENGTH_GUIDANCE[profile.summaryLength],
    '',
    'Rules:',
    '- Plain spoken prose only. No markdown, no bullet points, no asterisks, no headings.',
    '- Never read a URL aloud. If the email is asking them to visit a link, say what the link is',
    '  for instead ("there is a link to reset your password").',
    '- Ignore tracking pixels, unsubscribe footers, legal disclaimers, address blocks, and',
    '  "view this in your browser" boilerplate.',
    '- If the email needs a reply, a payment, or an appointment kept, say that clearly and say by',
    '  when.',
    '- If the email is a promotion, a receipt, or a notification requiring nothing, say so in one',
    '  sentence and stop.',
    '- Do not editorialise, do not add advice they did not ask for, and do not guess at anything',
    '  the email does not say.',
    '- Never begin with "This email" or "The sender". Start with the substance.',
    '',
    `From: ${header.fromName} <${header.fromAddress}>`,
    `Subject: ${header.subject}`,
    '',
    'Email body:',
    '---',
    truncateBody(body),
    '---'
  ].join('\n')
}

/**
 * Newsletters routinely run past 100 KB of boilerplate. The useful content is at the top, and
 * sending the whole thing wastes tokens and dilutes the summary.
 */
export function truncateBody(body: string, limit = 12_000): string {
  if (body.length <= limit) return body
  return `${body.slice(0, limit)}\n\n[The rest of this email was too long to include.]`
}

/** Header read aloud before the user decides whether to hear more. */
export function headerAnnouncement(
  header: EmailHeader,
  spokenDate: string,
  position: number,
  total: number
): string {
  const place = total > 1 ? `Email ${position} of ${total}. ` : ''
  const when = spokenDate ? `, ${spokenDate}` : ''
  return (
    `${place}From ${header.fromName}${when}. Subject: ${header.subject}. ` +
    'Read the sender and subject to the user in your own natural phrasing, then offer Skip, ' +
    'Read More, or Delete as the next step. Keep it to one short question. Do not add other ' +
    'options unless they ask.'
  )
}
