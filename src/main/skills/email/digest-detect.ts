import type { EmailBody, EmailHeader, EmailLink, UserProfile } from '../../../shared/types'

/** URL junk: unsubscribe, legal, ads. Not applied to link text — headlines mention "privacy". */
const NON_ARTICLE_HREF_PATTERNS = [
  /unsubscribe/i,
  /email[-_]?prefs?/i,
  /manage[-_]?subscription/i,
  /opt[-_]?out/i,
  /view.{0,3}in.{0,3}browser/i,
  /webversion/i,
  /forward.?to.?a.?friend/i,
  /\/privacy(?:[/?#]|$)/i,
  /\/terms(?:[/?#]|$)/i,
  /\/legal(?:[/?#]|$)/i,
  /\/contact(?:[/?#]|$)/i,
  /\/advertise(?:[/?#]|$)/i,
  /\/sponsor(?:[/?#]|$)/i,
  /utm_medium=(ad|sponsor)/i
]

/** Footer labels only. A headline like "Privacy Concerns" must not match. */
const NON_ARTICLE_TEXT_PATTERNS = [
  /^unsubscribe\b/i,
  /manage (your )?subscription/i,
  /view .{0,20}in .{0,10}browser/i,
  /^view online$/i,
  /^privacy policy$/i,
  /^terms of (use|service)$/i,
  /\badvertise with us\b/i,
  /\bemail preferences\b/i,
  /^preferences$/i,
  /^see all newsletters$/i,
  /^share your feedback$/i,
  /start your free trial/i,
  /^live now on\b/i,
  /©\d{4}/i,
  /\bthestreet,\s*inc\.?$/i
]

const ADDRESS_PATTERN =
  /^\d{1,5}\s+.+\b(rd|st|ave|blvd|dr|ln|way|ct|suite|ste|floor|fl)\b/i

const DATE_TITLE_PATTERN =
  /^(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day,?\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}$/i

/** Many click-wrappers share one path; this many hits means the path is not the article. */
const WRAPPER_PATH_THRESHOLD = 3

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
 * authoritative because the user has told us directly — publication names, domains, or addresses.
 * Heuristics only decide when auto-detect is on, and everything else is escalated to the model.
 */
export function detectLinkDigest(
  header: EmailHeader,
  body: EmailBody,
  profile: UserProfile
): DigestSignals {
  const articleLinks = filterArticleLinks(body.links, header.fromName)

  if (matchesSender(profile.nonDigestSenders, header)) {
    return { verdict: 'not-digest', reason: 'the user marked this sender as not a newsletter', articleLinks }
  }
  if (matchesSender(profile.digestSenders, header)) {
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
  const titles = new Set(
    articleLinks.map((link) => collapse(link.text).toLowerCase()).filter((title) => title.length >= 8)
  )

  // A link digest looks like: many links, mostly to distinct pages on one or two hosts, with
  // little prose of its own between them. Click-wrappers reuse one path (`/e/er`) for every
  // article, so unique titles count as distinct pages when the paths do not.
  const concentrated = hosts.size <= 2
  const distinctPages =
    paths.size >= articleLinks.length * 0.8 || titles.size >= articleLinks.length * 0.8
  const linkHeavy = anchorRatio > 0.25

  if (articleLinks.length >= 5 && distinctPages && concentrated) {
    return {
      verdict: 'digest',
      reason: `${articleLinks.length} distinct article titles from one publication`,
      articleLinks
    }
  }

  if (articleLinks.length >= 8 && distinctPages && linkHeavy) {
    return {
      verdict: 'uncertain',
      reason: 'several article-shaped links but mixed signals',
      articleLinks
    }
  }

  return { verdict: 'not-digest', reason: 'does not look like a list of articles', articleLinks }
}

/**
 * Drops anchors that cannot be articles. Runs before any model call so the model never has to
 * reason about unsubscribe footers.
 */
export function filterArticleLinks(links: EmailLink[], senderName = ''): EmailLink[] {
  const pathCounts = countPathKeys(links)
  const seenPaths = new Set<string>()
  const seenTitles = new Set<string>()
  const result: EmailLink[] = []
  const sender = senderName.trim().toLowerCase()

  for (const link of links) {
    const url = safeUrl(link.href)
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) continue

    const host = url.hostname.replace(/^www\./, '')
    if (SOCIAL_HOSTS.some((social) => host === social || host.endsWith(`.${social}`))) continue
    if (STORE_HOSTS.some((store) => host === store)) continue

    if (NON_ARTICLE_HREF_PATTERNS.some((pattern) => pattern.test(link.href))) continue
    if (link.text && NON_ARTICLE_TEXT_PATTERNS.some((pattern) => pattern.test(link.text))) continue

    const title = collapse(link.text)
    if (sender && title.toLowerCase() === sender) continue
    if (ADDRESS_PATTERN.test(title)) continue
    if (DATE_TITLE_PATTERN.test(title)) continue

    // A bare host with no path is a home page or section index, not an article.
    if (url.pathname === '/' || url.pathname === '') continue

    const pathKey = `${host}${url.pathname}`.replace(/\/$/, '').toLowerCase()
    const titleKey = title.toLowerCase()
    const clickWrapper = (pathCounts.get(pathKey) ?? 0) >= WRAPPER_PATH_THRESHOLD

    // Same path with different UTM usually means the same article. Eloqua/Moosend wrappers
    // reuse one path for every story (`/e/er?lid=…`), so those are deduped by title only.
    if (!clickWrapper && seenPaths.has(pathKey)) continue
    if (titleKey && seenTitles.has(titleKey)) continue
    if (!clickWrapper) seenPaths.add(pathKey)
    if (titleKey) seenTitles.add(titleKey)

    if (title.length < 8) continue

    result.push({ text: title, href: link.href })
  }

  return dropDekBlurbs(result)
}

function dropDekBlurbs(links: EmailLink[]): EmailLink[] {
  const kept: EmailLink[] = []
  for (const link of links) {
    const previous = kept[kept.length - 1]
    // Only drop a sentence-case blurb when it points at the same story as the headline above.
    // Without the href check, the next article's link looks like a blurb under the prior headline.
    if (
      previous &&
      looksLikeHeadline(previous.text) &&
      !looksLikeHeadline(link.text) &&
      sameArticleHref(previous.href, link.href)
    ) {
      continue
    }
    kept.push(link)
  }
  return kept
}

/** True when two anchors almost certainly target the same page (tracking params ignored). */
function sameArticleHref(a: string, b: string): boolean {
  if (a === b) return true
  const urlA = safeUrl(a)
  const urlB = safeUrl(b)
  if (!urlA || !urlB) return false
  const hostA = urlA.hostname.replace(/^www\./, '')
  const hostB = urlB.hostname.replace(/^www\./, '')
  if (hostA !== hostB) return false
  const pathA = urlA.pathname.replace(/\/$/, '')
  const pathB = urlB.pathname.replace(/\/$/, '')
  return pathA.length > 1 && pathA === pathB
}

const SMALL_WORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'and',
  'or',
  'to',
  'for',
  'in',
  'on',
  'at',
  'by',
  'vs',
  'via',
  'as'
])

/** Title Case (or a question) rather than a sentence-case blurb under a headline. */
function looksLikeHeadline(text: string): boolean {
  const value = collapse(text).replace(/[?!:]+$/u, '')
  if (/^plus[,:]?\s/i.test(value)) return false
  const words = value.split(/\s+/).filter(Boolean)
  if (words.length < 3) return false
  let significant = 0
  let titled = 0
  for (const word of words) {
    const bare = word.replace(/[^A-Za-z0-9]/gu, '')
    if (!bare || SMALL_WORDS.has(bare.toLowerCase())) continue
    significant += 1
    if (/^[A-Z0-9]/u.test(bare)) titled += 1
  }
  return significant > 0 && titled / significant >= 0.55
}

function countPathKeys(links: EmailLink[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const link of links) {
    const url = safeUrl(link.href)
    if (!url) continue
    const host = url.hostname.replace(/^www\./, '')
    const pathKey = `${host}${url.pathname}`.replace(/\/$/, '').toLowerCase()
    counts.set(pathKey, (counts.get(pathKey) ?? 0) + 1)
  }
  return counts
}

function matchesSender(
  list: string[],
  header: Pick<EmailHeader, 'fromAddress' | 'fromName'>
): boolean {
  const address = header.fromAddress.toLowerCase()
  const name = header.fromName.toLowerCase()
  const host = hostOfAddress(address)
  const compactName = name.replace(/\s+/g, '')

  return list.some((entry) => {
    const value = entry.trim().toLowerCase()
    if (!value) return false
    if (value.includes('@')) return address === value

    // `kiplinger.com` matches any mailbox at that domain or a subdomain of it.
    const looksLikeDomain = value.includes('.') && !/\s/.test(value)
    if (looksLikeDomain) return host === value || host.endsWith(`.${value}`)

    const compact = value.replace(/\s+/g, '')
    return name.includes(value) || compactName.includes(compact) || address.includes(compact)
  })
}

function hostOfAddress(address: string): string {
  const at = address.lastIndexOf('@')
  return (at >= 0 ? address.slice(at + 1) : address).replace(/^www\./, '')
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
