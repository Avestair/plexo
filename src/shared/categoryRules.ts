import type { CategoryRule } from './types'

/** The extension of a URL's last path segment (no dot, lowercased), or null when there isn't
 * one — e.g. no path, a trailing slash, or a dotfile-looking segment with nothing before the
 * dot. Query strings and fragments are ignored since they aren't part of the file name. */
export function extensionFromUrl(url: string): string | null {
  try {
    const { pathname } = new URL(url)
    const last = decodeURIComponent(pathname.split('/').filter(Boolean).pop() ?? '')
    const dot = last.lastIndexOf('.')
    if (dot <= 0 || dot === last.length - 1) return null
    return last.slice(dot + 1).toLowerCase()
  } catch {
    return null
  }
}

function ruleMatches(rule: CategoryRule, url: string): boolean {
  if (!rule.enabled) return false
  if (rule.matchType === 'extension') {
    const extension = extensionFromUrl(url)
    if (!extension) return false
    const list = rule.pattern
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
    return list.includes(extension)
  }
  // urlPattern — see CategoryRule.pattern's doc for exactly what this means.
  try {
    return new RegExp(rule.pattern, 'i').test(url)
  } catch {
    return false
  }
}

/**
 * The one place rule matching is actually decided — imported by both the main process
 * (CategoryRuleManager.matchRule, the source of truth once a rule is saved) and the renderer
 * (to suggest a match instantly, against the store's live copy of the rules, with no IPC round
 * trip needed just to classify a URL as the user types it).
 *
 * First enabled match wins, in ascending `order`. Rules are sorted defensively here rather than
 * trusted to already be in order, since this also runs against whatever shape the renderer's
 * store happens to hold.
 */
export function matchCategoryRule(url: string, rules: CategoryRule[]): string | null {
  const sorted = [...rules].sort((a, b) => a.order - b.order)
  for (const rule of sorted) {
    if (ruleMatches(rule, url)) return rule.targetQueueId
  }
  return null
}
