import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type {
  BandwidthLimit,
  BandwidthResetSchedule,
  QueueBandwidthSettings
} from '../../shared/types'
import { readJson, updateJson } from '../jsonFile'

// Per-queue bandwidth settings live in their own file, independent of queues.json, for the same
// reason schedules and system actions do (see scheduleStorage.ts): one corrupt file can't take
// down another. Same debounce/backup/sanitize-on-read approach throughout.

function bandwidthPath(): string {
  return join(app.getPath('userData'), 'bandwidth.json')
}

function backupPath(): string {
  return `${bandwidthPath()}.bak`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const RESET_SCHEDULES: BandwidthResetSchedule[] = ['daily', 'weekly', 'monthly', 'never']

function sanitizeLimit(parsed: unknown): BandwidthLimit | undefined {
  if (!isRecord(parsed)) return undefined
  const limit: BandwidthLimit = {
    usedBytes: typeof parsed.usedBytes === 'number' && parsed.usedBytes >= 0 ? parsed.usedBytes : 0
  }
  if (typeof parsed.maxSpeedBytesPerSec === 'number' && parsed.maxSpeedBytesPerSec >= 0) {
    limit.maxSpeedBytesPerSec = parsed.maxSpeedBytesPerSec
  }
  if (typeof parsed.maxTrafficBytes === 'number' && parsed.maxTrafficBytes >= 0) {
    limit.maxTrafficBytes = parsed.maxTrafficBytes
  }
  if (
    typeof parsed.resetSchedule === 'string' &&
    RESET_SCHEDULES.includes(parsed.resetSchedule as BandwidthResetSchedule)
  ) {
    limit.resetSchedule = parsed.resetSchedule as BandwidthResetSchedule
  }
  if (typeof parsed.lastResetAt === 'number') limit.lastResetAt = parsed.lastResetAt
  return limit
}

/** Trusts nothing past "this is valid JSON" — see queueStorage.ts's sanitizeItem for why. Every
 * entry is checked on its own, so one bad entry only drops that entry rather than the whole
 * file. */
function sanitizeEntry(parsed: unknown): QueueBandwidthSettings | undefined {
  if (!isRecord(parsed)) return undefined
  const { queueId } = parsed
  if (typeof queueId !== 'string') return undefined
  const entry: QueueBandwidthSettings = {
    queueId,
    useGlobalLimit: parsed.useGlobalLimit !== false
  }
  const limit = sanitizeLimit(parsed.limit)
  if (limit) entry.limit = limit
  return entry
}

function sanitizeEntries(parsed: unknown): QueueBandwidthSettings[] {
  if (!Array.isArray(parsed)) return []
  return parsed.map(sanitizeEntry).filter((entry): entry is QueueBandwidthSettings => !!entry)
}

/** Reads bandwidth.json, falling back to the last backup (see save) if the main file is missing
 * or corrupt, and to an empty list if both are. */
export async function loadBandwidthSettings(): Promise<QueueBandwidthSettings[]> {
  try {
    const parsed = await readJson(bandwidthPath())
    if (parsed !== undefined) return sanitizeEntries(parsed)
  } catch {
    // Fall through to the backup below.
  }
  try {
    const parsed = await readJson(backupPath())
    return parsed === undefined ? [] : sanitizeEntries(parsed)
  } catch {
    return []
  }
}

const AUTOSAVE_MS = 500
const MAX_WAIT_MS = 5_000

let timer: NodeJS.Timeout | null = null
let pending: QueueBandwidthSettings[] | null = null
let firstPendingAt: number | null = null
/** Resolves once every save scheduled so far (via scheduleSaveBandwidthSettings) has finished
 * writing — what flushBandwidthSettings awaits before quitting. */
let saveChain: Promise<void> = Promise.resolve()

async function writeEntries(entries: QueueBandwidthSettings[]): Promise<void> {
  const path = bandwidthPath()
  await copyFile(path, backupPath()).catch(() => {})
  await updateJson(path, () => entries)
}

function flushPending(): void {
  if (timer) clearTimeout(timer)
  timer = null
  const toSave = pending
  pending = null
  firstPendingAt = null
  if (toSave) saveChain = saveChain.catch(() => {}).then(() => writeEntries(toSave))
}

/** Debounced autosave, same shape as queueStorage.ts's scheduleSave: several changes in quick
 * succession (a usage tally updating every tick while a queue-capped download runs) collapse
 * into one write, AUTOSAVE_MS after the last of them — but never later than MAX_WAIT_MS after
 * the first of them. */
export function scheduleSaveBandwidthSettings(entries: QueueBandwidthSettings[]): void {
  pending = entries
  const now = Date.now()
  firstPendingAt ??= now
  if (timer) clearTimeout(timer)
  const wait = Math.min(AUTOSAVE_MS, firstPendingAt + MAX_WAIT_MS - now)
  timer = setTimeout(flushPending, Math.max(0, wait))
}

/** Saves `entries` immediately, skipping (and clearing) any pending debounced save — for app
 * shutdown, where there's no time left to wait out the debounce. */
export async function flushBandwidthSettings(entries: QueueBandwidthSettings[]): Promise<void> {
  if (timer) clearTimeout(timer)
  timer = null
  pending = null
  firstPendingAt = null
  saveChain = saveChain.catch(() => {}).then(() => writeEntries(entries))
  await saveChain
}
