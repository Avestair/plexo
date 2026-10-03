import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { QueueAction, SystemAction, SystemActionLogEntry } from '../../shared/types'
import { readJson, updateJson } from '../jsonFile'

// Post-download system-action config and log live in their own file, same reasoning as
// schedules.json (see scheduleStorage.ts): independent lifecycle from queues.json, so a bad file
// here can't corrupt (or block parsing of) the queues users care about, and vice versa. Same
// debounce/backup/sanitize-on-read approach throughout.

function systemActionsPath(): string {
  return join(app.getPath('userData'), 'system-actions.json')
}

function backupPath(): string {
  return `${systemActionsPath()}.bak`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const SYSTEM_ACTIONS: SystemAction[] = ['none', 'sleep', 'hibernate', 'shutdown']
const LOG_OUTCOMES: SystemActionLogEntry['outcome'][] = ['ran', 'cancelled', 'failed']

/** Most log entries kept — older ones are dropped on every save (see sanitizeLog). */
export const SYSTEM_ACTION_LOG_CAP = 100

export interface SystemActionData {
  actions: QueueAction[]
  log: SystemActionLogEntry[]
}

function emptyData(): SystemActionData {
  return { actions: [], log: [] }
}

/** Trusts nothing past "this is valid JSON" — see queueStorage.ts's sanitizeItem for why. Every
 * entry is checked on its own, so one bad entry only drops that entry rather than the whole
 * file. */
function sanitizeAction(parsed: unknown): QueueAction | undefined {
  if (!isRecord(parsed)) return undefined
  const { queueId, action, confirmBefore } = parsed
  if (typeof queueId !== 'string') return undefined
  if (typeof action !== 'string' || !SYSTEM_ACTIONS.includes(action as SystemAction)) {
    return undefined
  }
  const entry: QueueAction = {
    queueId,
    action: action as SystemAction,
    confirmBefore: confirmBefore === true
  }
  if (typeof parsed.countdownSeconds === 'number') entry.countdownSeconds = parsed.countdownSeconds
  return entry
}

function sanitizeLogEntry(parsed: unknown): SystemActionLogEntry | undefined {
  if (!isRecord(parsed)) return undefined
  const { id, queueId, queueName, action, at, outcome } = parsed
  if (typeof id !== 'string' || typeof queueId !== 'string' || typeof queueName !== 'string') {
    return undefined
  }
  if (typeof action !== 'string' || !SYSTEM_ACTIONS.includes(action as SystemAction)) {
    return undefined
  }
  if (typeof at !== 'number') return undefined
  if (
    typeof outcome !== 'string' ||
    !LOG_OUTCOMES.includes(outcome as SystemActionLogEntry['outcome'])
  ) {
    return undefined
  }
  const entry: SystemActionLogEntry = {
    id,
    queueId,
    queueName,
    action: action as SystemAction,
    at,
    outcome: outcome as SystemActionLogEntry['outcome']
  }
  if (typeof parsed.error === 'string') entry.error = parsed.error
  return entry
}

function sanitizeData(parsed: unknown): SystemActionData {
  if (!isRecord(parsed)) return emptyData()
  const actions = Array.isArray(parsed.actions)
    ? parsed.actions.map(sanitizeAction).filter((entry): entry is QueueAction => !!entry)
    : []
  const log = Array.isArray(parsed.log)
    ? parsed.log
        .map(sanitizeLogEntry)
        .filter((entry): entry is SystemActionLogEntry => !!entry)
        .slice(-SYSTEM_ACTION_LOG_CAP)
    : []
  return { actions, log }
}

/** Reads system-actions.json, falling back to the last backup (see save) if the main file is
 * missing or corrupt, and to an empty set if both are. */
export async function loadSystemActionData(): Promise<SystemActionData> {
  try {
    const parsed = await readJson(systemActionsPath())
    if (parsed !== undefined) return sanitizeData(parsed)
  } catch {
    // Fall through to the backup below.
  }
  try {
    const parsed = await readJson(backupPath())
    return parsed === undefined ? emptyData() : sanitizeData(parsed)
  } catch {
    return emptyData()
  }
}

const AUTOSAVE_MS = 500
const MAX_WAIT_MS = 5_000

let timer: NodeJS.Timeout | null = null
let pending: SystemActionData | null = null
let firstPendingAt: number | null = null
/** Resolves once every save scheduled so far has finished writing — what flushSystemActionData
 * awaits before quitting. */
let saveChain: Promise<void> = Promise.resolve()

async function writeData(data: SystemActionData): Promise<void> {
  const path = systemActionsPath()
  // Best-effort snapshot of what's there before it's overwritten — missing on first run, which
  // is fine, there is nothing yet worth keeping a backup of.
  await copyFile(path, backupPath()).catch(() => {})
  await updateJson(path, () => data)
}

function flushPending(): void {
  if (timer) clearTimeout(timer)
  timer = null
  const toSave = pending
  pending = null
  firstPendingAt = null
  if (toSave) saveChain = saveChain.catch(() => {}).then(() => writeData(toSave))
}

/** Debounced autosave, same shape as queueStorage.ts/scheduleStorage.ts's save functions. */
export function scheduleSaveSystemActionData(data: SystemActionData): void {
  pending = data
  const now = Date.now()
  firstPendingAt ??= now
  if (timer) clearTimeout(timer)
  const wait = Math.min(AUTOSAVE_MS, firstPendingAt + MAX_WAIT_MS - now)
  timer = setTimeout(flushPending, Math.max(0, wait))
}

/** Saves `data` immediately, skipping (and clearing) any pending debounced save — for app
 * shutdown, where there's no time left to wait out the debounce. */
export async function flushSystemActionData(data: SystemActionData): Promise<void> {
  if (timer) clearTimeout(timer)
  timer = null
  pending = null
  firstPendingAt = null
  saveChain = saveChain.catch(() => {}).then(() => writeData(data))
  await saveChain
}
