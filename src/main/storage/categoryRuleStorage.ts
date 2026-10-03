import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { CategoryRule } from '../../shared/types'
import { readJson, updateJson } from '../jsonFile'

// Category rules live in their own file, same reasoning as schedules.json/systemActions.json: a
// rule's lifecycle is independent of any single Queue, and a bad categoryRules.json can never
// corrupt (or block parsing of) queues.json. Same debounce/backup/sanitize-on-read approach as
// the rest of main/storage throughout.

function categoryRulesPath(): string {
  return join(app.getPath('userData'), 'categoryRules.json')
}

function backupPath(): string {
  return `${categoryRulesPath()}.bak`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const MATCH_TYPES: CategoryRule['matchType'][] = ['extension', 'urlPattern']

/** Trusts nothing past "this is valid JSON" — see queueStorage.ts's sanitizeItem for why. Every
 * rule is checked on its own, so one bad entry only drops that entry rather than the whole file. */
function sanitizeRule(parsed: unknown): CategoryRule | undefined {
  if (!isRecord(parsed)) return undefined
  const { id, name, matchType, pattern, targetQueueId } = parsed
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof matchType !== 'string' ||
    !MATCH_TYPES.includes(matchType as CategoryRule['matchType']) ||
    typeof pattern !== 'string' ||
    typeof targetQueueId !== 'string'
  ) {
    return undefined
  }
  return {
    id,
    name,
    matchType: matchType as CategoryRule['matchType'],
    pattern,
    targetQueueId,
    enabled: parsed.enabled === true,
    order: typeof parsed.order === 'number' ? parsed.order : 0
  }
}

function sanitizeRules(parsed: unknown): CategoryRule[] {
  if (!Array.isArray(parsed)) return []
  return parsed.map(sanitizeRule).filter((rule): rule is CategoryRule => !!rule)
}

/** Reads categoryRules.json, falling back to the last backup (see save) if the main file is
 * missing or corrupt, and to an empty list if both are. */
export async function loadCategoryRules(): Promise<CategoryRule[]> {
  try {
    const parsed = await readJson(categoryRulesPath())
    if (parsed !== undefined) return sanitizeRules(parsed)
  } catch {
    // Fall through to the backup below.
  }
  try {
    const parsed = await readJson(backupPath())
    return parsed === undefined ? [] : sanitizeRules(parsed)
  } catch {
    return []
  }
}

const AUTOSAVE_MS = 500
const MAX_WAIT_MS = 5_000

let timer: NodeJS.Timeout | null = null
let pending: CategoryRule[] | null = null
let firstPendingAt: number | null = null
/** Resolves once every save scheduled so far (via saveCategoryRules) has finished writing — what
 * flushCategoryRules awaits before quitting. */
let saveChain: Promise<void> = Promise.resolve()

async function writeRules(rules: CategoryRule[]): Promise<void> {
  const path = categoryRulesPath()
  await copyFile(path, backupPath()).catch(() => {})
  await updateJson(path, () => rules)
}

function flushPending(): void {
  if (timer) clearTimeout(timer)
  timer = null
  const toSave = pending
  pending = null
  firstPendingAt = null
  if (toSave) saveChain = saveChain.catch(() => {}).then(() => writeRules(toSave))
}

/** Debounced autosave, same shape as scheduleStorage.ts's saveSchedules. */
export function saveCategoryRules(rules: CategoryRule[]): void {
  pending = rules
  const now = Date.now()
  firstPendingAt ??= now
  if (timer) clearTimeout(timer)
  const wait = Math.min(AUTOSAVE_MS, firstPendingAt + MAX_WAIT_MS - now)
  timer = setTimeout(flushPending, Math.max(0, wait))
}

/** Saves `rules` immediately, skipping (and clearing) any pending debounced save — for app
 * shutdown, where there's no time left to wait out the debounce. */
export async function flushCategoryRules(rules: CategoryRule[]): Promise<void> {
  if (timer) clearTimeout(timer)
  timer = null
  pending = null
  firstPendingAt = null
  saveChain = saveChain.catch(() => {}).then(() => writeRules(rules))
  await saveChain
}
