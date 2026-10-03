import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { Queue, QueueItem, QueueItemStatus, QueueStatus } from '../../shared/types'
import { readJson, updateJson } from '../jsonFile'

function queuesPath(): string {
  return join(app.getPath('userData'), 'queues.json')
}

function backupPath(): string {
  return `${queuesPath()}.bak`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const ITEM_STATUSES: QueueItemStatus[] = ['pending', 'downloading', 'paused', 'completed', 'failed']
const QUEUE_STATUSES: QueueStatus[] = ['idle', 'active', 'paused', 'completed']

/** Trusts nothing past "this is valid JSON" — the file may be hand-edited, from an older
 * version, or truncated by a crash. Every item is checked on its own, so one bad entry only
 * drops that entry rather than the whole file. */
function sanitizeItem(parsed: unknown): QueueItem | undefined {
  if (!isRecord(parsed)) return undefined
  const { id, url, fileName, status, addedAt } = parsed
  if (typeof id !== 'string' || typeof url !== 'string' || typeof fileName !== 'string') {
    return undefined
  }
  if (typeof status !== 'string' || !ITEM_STATUSES.includes(status as QueueItemStatus)) {
    return undefined
  }
  const item: QueueItem = {
    id,
    url,
    fileName,
    status: status as QueueItemStatus,
    progress: typeof parsed.progress === 'number' ? parsed.progress : 0,
    size: typeof parsed.size === 'number' ? parsed.size : 0,
    downloadedSize: typeof parsed.downloadedSize === 'number' ? parsed.downloadedSize : 0,
    speedBytesPerSec: typeof parsed.speedBytesPerSec === 'number' ? parsed.speedBytesPerSec : 0,
    timeRemainingSec: typeof parsed.timeRemainingSec === 'number' ? parsed.timeRemainingSec : 0,
    addedAt: typeof addedAt === 'number' ? addedAt : Date.now()
  }
  if (typeof parsed.completedAt === 'number') item.completedAt = parsed.completedAt
  if (typeof parsed.error === 'string') item.error = parsed.error
  return item
}

function sanitizeQueue(parsed: unknown): Queue | undefined {
  if (!isRecord(parsed)) return undefined
  const { id, name, createdAt, status } = parsed
  if (typeof id !== 'string' || typeof name !== 'string') return undefined
  const items = Array.isArray(parsed.items)
    ? parsed.items.map(sanitizeItem).filter((item): item is QueueItem => !!item)
    : []
  const queue: Queue = {
    id,
    name,
    createdAt: typeof createdAt === 'number' ? createdAt : Date.now(),
    items,
    status:
      typeof status === 'string' && QUEUE_STATUSES.includes(status as QueueStatus)
        ? (status as QueueStatus)
        : 'idle',
    totalProgress: typeof parsed.totalProgress === 'number' ? parsed.totalProgress : 0
  }
  if (typeof parsed.description === 'string') queue.description = parsed.description
  return queue
}

function sanitizeQueues(parsed: unknown): Queue[] {
  if (!Array.isArray(parsed)) return []
  return parsed.map(sanitizeQueue).filter((queue): queue is Queue => !!queue)
}

/** Reads queues.json, falling back to the last backup (see save) if the main file is missing or
 * corrupt, and to an empty list if both are. */
export async function loadQueues(): Promise<Queue[]> {
  try {
    const parsed = await readJson(queuesPath())
    if (parsed !== undefined) return sanitizeQueues(parsed)
  } catch {
    // Fall through to the backup below.
  }
  try {
    const parsed = await readJson(backupPath())
    return parsed === undefined ? [] : sanitizeQueues(parsed)
  } catch {
    return []
  }
}

const AUTOSAVE_MS = 500
// An active download reports progress every 500ms (see DownloadManager's TICK_MS), which calls
// scheduleSave on every tick — without a ceiling, that resets AUTOSAVE_MS's timer forever and the
// whole file (every queue, not just the one downloading) never reaches disk until it stops.
const MAX_WAIT_MS = 5_000

let timer: NodeJS.Timeout | null = null
let pending: Queue[] | null = null
let firstPendingAt: number | null = null
/** Resolves once every save scheduled so far (via scheduleSave) has finished writing — what
 * flushQueues awaits before quitting. */
let saveChain: Promise<void> = Promise.resolve()

async function writeQueues(queues: Queue[]): Promise<void> {
  const path = queuesPath()
  // Best-effort snapshot of what's there before it's overwritten — missing on first run, which
  // is fine, there is nothing yet worth keeping a backup of.
  await copyFile(path, backupPath()).catch(() => {})
  await updateJson(path, () => queues)
}

function flushPending(): void {
  if (timer) clearTimeout(timer)
  timer = null
  const toSave = pending
  pending = null
  firstPendingAt = null
  if (toSave) saveChain = saveChain.catch(() => {}).then(() => writeQueues(toSave))
}

/** Debounced autosave: several changes in quick succession (adding a few URLs, a drag reorder)
 * collapse into one write, AUTOSAVE_MS after the last of them — but never later than MAX_WAIT_MS
 * after the first of them, so a steady stream of changes (an active download's progress ticks)
 * can't push the save off indefinitely. */
export function scheduleSave(queues: Queue[]): void {
  pending = queues
  const now = Date.now()
  firstPendingAt ??= now
  if (timer) clearTimeout(timer)
  const wait = Math.min(AUTOSAVE_MS, firstPendingAt + MAX_WAIT_MS - now)
  timer = setTimeout(flushPending, Math.max(0, wait))
}

/** Saves `queues` immediately, skipping (and clearing) any pending debounced save — for app
 * shutdown, where there's no time left to wait out the debounce. */
export async function flushQueues(queues: Queue[]): Promise<void> {
  if (timer) clearTimeout(timer)
  timer = null
  pending = null
  firstPendingAt = null
  saveChain = saveChain.catch(() => {}).then(() => writeQueues(queues))
  await saveChain
}
