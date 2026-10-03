import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { ChecksumStatus, HashAlgorithm, HistoryEntry } from '../../shared/types'
import { readJson, updateJson } from '../jsonFile'
import { testKnobs } from '../testKnobs'

function historyPath(): string {
  return join(app.getPath('userData'), 'history.json')
}

function backupPath(): string {
  return `${historyPath()}.bak`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const ENTRY_STATUSES: HistoryEntry['status'][] = ['completed', 'failed', 'cancelled']
const HASH_ALGORITHMS: HashAlgorithm[] = ['md5', 'sha1', 'sha256']
const CHECKSUM_STATUSES: ChecksumStatus[] = [
  'not_checked',
  'verifying',
  'match',
  'mismatch',
  'error'
]

/** Trusts nothing past "this is valid JSON" — same policy as queueStorage.ts's sanitizeItem: the
 * file may be hand-edited, from an older version, or truncated by a crash, so every entry is
 * checked on its own and one bad one only drops that entry. */
function sanitizeEntry(parsed: unknown): HistoryEntry | undefined {
  if (!isRecord(parsed)) return undefined
  const { id, url, fileName, destinationPath, status, startedAt, finishedAt, source } = parsed
  if (
    typeof id !== 'string' ||
    typeof url !== 'string' ||
    typeof fileName !== 'string' ||
    typeof destinationPath !== 'string'
  ) {
    return undefined
  }
  if (typeof status !== 'string' || !ENTRY_STATUSES.includes(status as HistoryEntry['status'])) {
    return undefined
  }
  if (source !== 'adhoc' && source !== 'queue') return undefined

  const entry: HistoryEntry = {
    id,
    url,
    fileName,
    destinationPath,
    size: typeof parsed.size === 'number' ? parsed.size : 0,
    status: status as HistoryEntry['status'],
    startedAt: typeof startedAt === 'number' ? startedAt : 0,
    finishedAt: typeof finishedAt === 'number' ? finishedAt : 0,
    source
  }
  if (typeof parsed.queueId === 'string') entry.queueId = parsed.queueId
  if (typeof parsed.queueName === 'string') entry.queueName = parsed.queueName
  if (typeof parsed.error === 'string') entry.error = parsed.error
  if (typeof parsed.checksumComputedHex === 'string') {
    entry.checksumComputedHex = parsed.checksumComputedHex
  }
  if (
    typeof parsed.checksumStatus === 'string' &&
    CHECKSUM_STATUSES.includes(parsed.checksumStatus as ChecksumStatus)
  ) {
    entry.checksumStatus = parsed.checksumStatus as ChecksumStatus
  }
  if (isRecord(parsed.checksum)) {
    const { algorithm, expectedHex } = parsed.checksum
    if (
      typeof algorithm === 'string' &&
      HASH_ALGORITHMS.includes(algorithm as HashAlgorithm) &&
      typeof expectedHex === 'string'
    ) {
      entry.checksum = { algorithm: algorithm as HashAlgorithm, expectedHex }
    }
  }
  return entry
}

function sanitizeEntries(parsed: unknown): HistoryEntry[] {
  if (!Array.isArray(parsed)) return []
  return parsed.map(sanitizeEntry).filter((entry): entry is HistoryEntry => !!entry)
}

/** Reads history.json, falling back to the last backup (see save) if the main file is missing or
 * corrupt, and to an empty list if both are — same fallback policy as queueStorage.ts. */
export async function loadHistory(): Promise<HistoryEntry[]> {
  try {
    const parsed = await readJson(historyPath())
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
let pending: HistoryEntry[] | null = null
let firstPendingAt: number | null = null
let saveChain: Promise<void> = Promise.resolve()

/** Entries are capped to the most recent testKnobs.historyCapEntries (1000 outside tests) before
 * ever reaching disk — a long-lived install downloads indefinitely, and nothing here needs more
 * than roughly "what did I download recently" for search to stay useful and the file small. The
 * oldest entries (by position — the manager always prepends new ones, so the tail is the oldest)
 * are dropped first. */
function capEntries(entries: HistoryEntry[]): HistoryEntry[] {
  return entries.slice(0, testKnobs.historyCapEntries)
}

async function writeHistory(entries: HistoryEntry[]): Promise<void> {
  const path = historyPath()
  await copyFile(path, backupPath()).catch(() => {})
  await updateJson(path, () => capEntries(entries))
}

function flushPending(): void {
  if (timer) clearTimeout(timer)
  timer = null
  const toSave = pending
  pending = null
  firstPendingAt = null
  if (toSave) saveChain = saveChain.catch(() => {}).then(() => writeHistory(toSave))
}

/** Debounced autosave, same shape as queueStorage.ts's scheduleSave — several completions in
 * quick succession (a queue finishing a run of items) collapse into one write. */
export function scheduleSaveHistory(entries: HistoryEntry[]): void {
  pending = entries
  const now = Date.now()
  firstPendingAt ??= now
  if (timer) clearTimeout(timer)
  const wait = Math.min(AUTOSAVE_MS, firstPendingAt + MAX_WAIT_MS - now)
  timer = setTimeout(flushPending, Math.max(0, wait))
}

/** Saves `entries` immediately, skipping (and clearing) any pending debounced save — for app
 * shutdown. */
export async function flushHistory(entries: HistoryEntry[]): Promise<void> {
  if (timer) clearTimeout(timer)
  timer = null
  pending = null
  firstPendingAt = null
  saveChain = saveChain.catch(() => {}).then(() => writeHistory(entries))
  await saveChain
}
