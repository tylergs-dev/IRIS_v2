import type { gmail_v1 } from '@googleapis/gmail'
import { convert } from 'html-to-text'
import * as cheerio from 'cheerio'
import type { EmailBody, EmailHeader, EmailLink } from '../../../shared/types'

type Part = gmail_v1.Schema$MessagePart

export function headerValue(headers: Part['headers'], name: string): string {
  const match = headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())
  return match?.value ?? ''
}

/** Splits `Alice Smith <alice@example.com>` into its parts, tolerating quotes and bare addresses. */
export function parseFrom(raw: string): { name: string; address: string } {
  const angled = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/)
  if (angled) {
    const name = angled[1].replace(/^"(.*)"$/, '$1').trim()
    const address = angled[2].trim()
    return { name: name || address, address }
  }
  const address = raw.trim()
  return { name: address, address }
}

export function toHeader(message: gmail_v1.Schema$Message): EmailHeader {
  const headers = message.payload?.headers
  const from = parseFrom(headerValue(headers, 'From'))
  return {
    id: message.id ?? '',
    threadId: message.threadId ?? '',
    fromName: from.name,
    fromAddress: from.address,
    subject: headerValue(headers, 'Subject') || '(no subject)',
    date: headerValue(headers, 'Date'),
    snippet: decodeEntities(message.snippet ?? '')
  }
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8')
}

/** Depth-first search for the first part of a given MIME type, skipping attachments. */
function findPart(part: Part | undefined, mimeType: string): Part | undefined {
  if (!part) return undefined
  if (part.mimeType === mimeType && part.body?.data) return part
  for (const child of part.parts ?? []) {
    // A forwarded message can contain its own text/html; that is still body content, but a
    // named attachment is not.
    if (child.filename) continue
    const found = findPart(child, mimeType)
    if (found) return found
  }
  return undefined
}

export function extractBody(message: gmail_v1.Schema$Message): EmailBody {
  const payload = message.payload

  const plain = findPart(payload, 'text/plain')
  const html = findPart(payload, 'text/html')

  if (plain?.body?.data) {
    const text = decodeBase64Url(plain.body.data)
    // Links still come from the HTML alternative when there is one: plain-text parts often
    // carry only bare URLs with no indication of what they point to.
    const links = html?.body?.data ? extractLinks(decodeBase64Url(html.body.data)) : []
    return { text: normalizeText(text), links, isHtmlDerived: false }
  }

  if (html?.body?.data) {
    const source = decodeBase64Url(html.body.data)
    return {
      text: normalizeText(htmlToSpeakableText(source)),
      links: extractLinks(source),
      isHtmlDerived: true
    }
  }

  return { text: decodeEntities(message.snippet ?? ''), links: [], isHtmlDerived: false }
}

/**
 * Tuned for listening, not reading. Tracking URLs are routinely hundreds of characters long, and
 * a screen reader voicing one mid-sentence makes the email unusable, so hrefs are dropped from
 * the prose and surfaced separately via extractLinks.
 */
export function htmlToSpeakableText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'hr', format: 'skip' },
      // Newsletter layout tables are decoration; announcing them as tables is pure noise.
      { selector: 'table', format: 'dataTable' },
      { selector: 'style', format: 'skip' },
      { selector: 'script', format: 'skip' }
    ]
  })
}

const CTA_TITLES = new Set([
  'read more',
  'click here',
  'learn more',
  'continue reading',
  'see more',
  'find out more',
  'read the story',
  'full story',
  'more'
])

export function extractLinks(html: string): EmailLink[] {
  const $ = cheerio.load(html)
  const markers = collectMarkers($)
  const links: EmailLink[] = []
  const seen = new Set<string>()
  const usedHeadlines = new Set<string>()

  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]
    if (marker.kind !== 'link') continue
    if (seen.has(marker.href)) continue
    seen.add(marker.href)

    let text = marker.text
    if (!isHeadline(text)) {
      text = nearbyHeadline(markers, i, usedHeadlines) ?? text
    }

    links.push({ text, href: marker.href })
  }

  return links
}

type Marker = { kind: 'link'; href: string; text: string } | { kind: 'headline'; text: string }

function collectMarkers($: cheerio.CheerioAPI): Marker[] {
  const markers: Marker[] = []
  $('a[href], h1, h2, h3, h4, p, span, td, strong, b, font, div').each((_index, element) => {
    const node = $(element)
    if (node.is('a')) {
      const href = (node.attr('href') ?? '').trim()
      if (!/^https?:\/\//i.test(href)) return
      markers.push({ kind: 'link', href, text: titleFromOwnAnchor(node) })
      return
    }
    if (node.closest('a').length) return
    if (node.find('a, h1, h2, h3, h4, p, table, div').length) return
    const text = collapseSpace(node.text())
    if (isHeadline(text)) markers.push({ kind: 'headline', text })
  })
  return markers
}

function titleFromOwnAnchor(node: cheerio.Cheerio<cheerio.Element>): string {
  const own = collapseSpace(node.text())
  if (isHeadline(own)) return own
  const img = node.find('img').first()
  for (const candidate of [img.attr('alt'), img.attr('title'), node.attr('aria-label'), node.attr('title')]) {
    const value = collapseSpace(candidate ?? '')
    if (isHeadline(value)) return value
  }
  return own
}

function nearbyHeadline(
  markers: Marker[],
  linkIndex: number,
  usedHeadlines: Set<string>
): string | null {
  for (let j = linkIndex + 1; j < markers.length; j++) {
    const next = markers[j]
    if (next.kind === 'link' && isHeadline(next.text)) break
    if (next.kind === 'headline') {
      const key = next.text.toLowerCase()
      if (usedHeadlines.has(key)) continue
      usedHeadlines.add(key)
      return next.text
    }
  }
  for (let j = linkIndex - 1; j >= 0; j--) {
    const prev = markers[j]
    if (prev.kind === 'link' && isHeadline(prev.text)) break
    if (prev.kind === 'headline') {
      const key = prev.text.toLowerCase()
      if (usedHeadlines.has(key)) continue
      usedHeadlines.add(key)
      return prev.text
    }
  }
  return null
}

function isHeadline(text: string): boolean {
  const value = collapseSpace(text)
  if (value.length < 12 || value.length > 160) return false
  if (CTA_TITLES.has(value.toLowerCase())) return false
  if (value.split(' ').filter(Boolean).length < 3) return false
  if ((value.match(/[.!?]/g) ?? []).length > 1) return false
  return /[a-zA-Z]/.test(value)
}

function collapseSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Collapses the runaway blank lines and separator bars that newsletters are full of. */
export function normalizeText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      // Separator bars are removed before collapsing blank lines, or the now-empty lines they
      // leave behind become blank lines of their own.
      .replace(/^[ \t]*[-=_*~]{4,}[ \t]*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

function decodeEntities(value: string): string {
  if (!value.includes('&')) return value
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

/** Speech-friendly relative date: a listener wants "yesterday", not a timestamp. */
export function describeDate(raw: string, now = new Date()): string {
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return ''

  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) {
    return `today at ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
  }

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) {
    return `yesterday at ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
  }

  const days = Math.round((now.getTime() - date.getTime()) / 86_400_000)
  if (days < 7) return date.toLocaleDateString('en-US', { weekday: 'long' })
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
}
