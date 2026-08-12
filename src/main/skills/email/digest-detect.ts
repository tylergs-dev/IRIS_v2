import type { EmailBody, EmailHeader, EmailLink, UserProfile } from '../../../shared/types'

/** Hosts and paths that are never the article itself. */
const NON_ARTICLE_PATTERNS = [
  /unsubscribe/i,
  /email[-_]?prefs?/i,
  /preferences/i,
  /manage[-_]?subscription/i,
  /opt[-_]?out/i,
  /view.{0,3}in.{0,3}browser/i,
  /webversion/i,
  /forward.?to.?a.?friend/i,
  /privacy/i,
  /terms/i,
  /\/legal\b/i,
  /\/contact\b/i,
  /\/advertise\b/i,
  /\/sponsor/i,
  /utm_medium=(ad|sponsor)/i
]

const SOCIAL_HOSTS = [
  'facebook.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'linkedin.com',
  'youtube.com',
  'threads.net',
  'bsky.app',
  'reddit.com',
  't.me',
  'whatsapp.com',
  'pinterest.com',
  'tiktok.com'
]

const STORE_HOSTS = ['apps.apple.com', 'play.google.com', 'itunes.apple.com']

export type DigestVerdict = 'digest' | 'not-digest' | 'uncertain'

export interface DigestSignals {
  verdict: DigestVerdict
  /** Why, in plain language, so the decision can be explained or corrected. */
  reason: string
  articleLinks: EmailLink[]
}

/**
 * Layered cheapest-first so the outcome is explainable and correctable. The sender lists are
 * authoritative because the user has told us directly; heuristics only decide when they are
 * confident, and everything else is escalated to the model by the caller.
 */
export function detectLinkDigest(
  header: EmailHeader,
  body: EmailBody,
  profile: UserProfile
): DigestSignals {
  const sender = header.fromAddress.toLowerCase()
  const articleLinks = filterArticleLinks(body.links)

  if (matchesSender(profile.nonDigestSenders, sender)) {
    return { verdict: 'not-digest', reason: 'the user marked this sender as not a newsletter', articleLinks }
  }
  if (matchesSender(profile.digestSenders, sender)) {
    return { verdict: 'digest', reason: 'the user marked this sender as a newsletter', articleLinks }
  }
  if (!profile.autoDetectDigests) {
    return { verdict: 'not-digest', reason: 'automatic newsletter detection is turned off', articleLinks }
  }

  const total = body.links.length
  if (total < 6 || articleLinks.length < 4) {
    return { verdict: 'not-digest', reason: 'too few article links to be a digest', articleLinks }
  }

  const anchorChars = body.links.reduce((sum, link) => sum + link.text.length, 0)
  const prose = body.text.length || 1
  const anchorRatio = anchorChars / prose

  const hosts = new Set(articleLinks.map(hostOf).filter(Boolean))
  const paths = new Set(articleLinks.map((link) => safeUrl(link.href)?.pathname).filter(Boolean))

  // A link digest looks like: many links, mostly to distinct pages on one or two hosts, with
  // little prose of its own between them.
  const concentrated = hosts.size <= 2
  const distinctPages = paths.size >= articleLinks.length * 0.8
  const linkHeavy = anchorRatio > 0.25

  if (articleLinks.length >= 8 && concentrated && distinctPages && linkHeavy) {
    return {
      verdict: 'digest',
      reason: `${articleLinks.length} article links to distinct pages with little prose between them`,
      articleLinks
    }
  }

  if (articleLinks.length >= 5 && distinctPages && (concentrated || linkHeavy)) {
    return { verdict: 'uncertain', reason: 'several article-shaped links but mixed signals', articleLinks }
  }

  return { verdict: 'not-digest', reason: 'does not look like a list of articles', articleLinks }
}

/**
 * Drops anchors that cannot be articles. Runs before any model call so the model never has to
 * reason about unsubscribe footers.
 */
export function filterArticleLinks(links: EmailLink[]): EmailLink[] {
  const seen = new Set<string>()
  const result: EmailLink[] = []

  for (const link of links) {
    const url = safeUrl(link.href)
    if (!url) continue
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue

    const host = url.hostname.replace(/^www\./, '')
    if (SOCIAL_HOSTS.some((social) => host === social || host.endsWith(`.${social}`))) continue
    if (STORE_HOSTS.some((store) => host === store)) continue

    if (NON_ARTICLE_PATTERNS.some((pattern) => pattern.test(link.href))) continue
    if (link.text && NON_ARTICLE_PATTERNS.some((pattern) => pattern.test(link.text))) continue

    // A bare host with no path is a home page or section index, not an article.
    if (url.pathname === '/' || url.pathname === '') continue

    // Dedupe ignoring tracking parameters, which differ per link even for the same article.
    const key = `${host}${url.pathname}`.replace(/\/$/, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    // An anchor with no readable text cannot be announced; the model would have to invent a title.
    if (link.text.trim().length < 8) continue

    result.push({ text: collapse(link.text), href: link.href })
  }

  return result
}

function matchesSender(list: string[], sender: string): boolean {
  return list.some((entry) => {
    const value = entry.trim().toLowerCase()
    if (!value) return false
    // A bare domain entry matches every sender at that domain.
    if (!value.includes('@')) return sender.endsWith(`@${value}`) || sender.endsWith(value)
    return sender === value
  })
}

function safeUrl(href: string): URL | null {
  try {
    return new URL(href)
  } catch {
    return null
  }
}

function hostOf(link: EmailLink): string {
  return safeUrl(link.href)?.hostname.replace(/^www\./, '') ?? ''
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
