import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { QueueSchedule, WeeklyRepeat } from '../../shared/types'
import { readJson, updateJson } from '../jsonFile'

// Schedules live in their own file rather than nested onto each Queue in queues.json: a
// schedule's lifecycle (fired, rolled forward, disabled) is driven by ScheduleManager on a timer
// independent of anything QueueManager does, and keeping the two files separate means a bad
// schedules.json can never corrupt (or block parsing of) the queues users actually care about,
// and vice versa. Same debounce/backup/sanitize-on-read approach as queueStorage.ts throughout.

function schedulesPath(): string {
  return join(app.getPath('userData'), 'schedules.json')
}

function backupPath(): string {
  return `${schedulesPath()}.bak`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const WEEKDAY_KEYS: (keyof WeeklyRepeat)[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday'
]

function sanitizeWeeklyRepeat(parsed: unknown): WeeklyRepeat | undefined {
  if (!isRecord(parsed)) return undefined
  const weekly = {} as WeeklyRepeat
  for (const day of WEEKDAY_KEYS) weekly[day] = parsed[day] === true
  return weekly
}

/** Trusts nothing past "this is valid JSON" — see queueStorage.ts's sanitizeItem for why: the
 * file may be hand-edited, from an older version, or truncated by a crash. Every schedule is
 * checked on its own, so one bad entry only drops that entry rather than the whole file. */
function sanitizeSchedule(parsed: unknown): QueueSchedule | undefined {
  if (!isRecord(parsed)) return undefined
  const { queueId, startTime, enabled } = parsed
  if (typeof queueId !== 'string') return undefined
  const schedule: QueueSchedule = {
    queueId,
    startTime: typeof startTime === 'number' ? startTime : null,
    enabled: enabled === true
  }
  if (typeof parsed.sleepTime === 'number') schedule.sleepTime = parsed.sleepTime
  else if (parsed.sleepTime === null) schedule.sleepTime = null
  if (typeof parsed.repeatDaily === 'boolean') schedule.repeatDaily = parsed.repeatDaily
  const repeatWeekly = sanitizeWeeklyRepeat(parsed.repeatWeekly)
  if (repeatWeekly) schedule.repeatWeekly = repeatWeekly
  return schedule
}

function sanitizeSchedules(parsed: unknown): QueueSchedule[] {
  if (!Array.isArray(parsed)) return []
  return parsed.map(sanitizeSchedule).filter((schedule): schedule is QueueSchedule => !!schedule)
}

/** Reads schedules.json, falling back to the last backup (see save) if the main file is missing
 * or corrupt, and to an empty list if both are. */
export async function loadSchedules(): Promise<QueueSchedule[]> {
  try {
    const parsed = await readJson(schedulesPath())
    if (parsed !== undefined) return sanitizeSchedules(parsed)
  } catch {
    // Fall through to the backup below.
  }
  try {
    const parsed = await readJson(backupPath())
    return parsed === undefined ? [] : sanitizeSchedules(parsed)
  } catch {
    return []
  }
}

const AUTOSAVE_MS = 500
const MAX_WAIT_MS = 5_000

let timer: NodeJS.Timeout | null = null
let pending: QueueSchedule[] | null = null
let firstPendingAt: number | null = null
/** Resolves once every save scheduled so far (via saveSchedules) has finished writing — what
 * flushSchedules awaits before quitting. */
let saveChain: Promise<void> = Promise.resolve()

async function writeSchedules(schedules: QueueSchedule[]): Promise<void> {
  const path = schedulesPath()
  // Best-effort snapshot of what's there before it's overwritten — missing on first run, which
  // is fine, there is nothing yet worth keeping a backup of.
  await copyFile(path, backupPath()).catch(() => {})
  await updateJson(path, () => schedules)
}

function flushPending(): void {
  if (timer) clearTimeout(timer)
  timer = null
  const toSave = pending
  pending = null
  firstPendingAt = null
  if (toSave) saveChain = saveChain.catch(() => {}).then(() => writeSchedules(toSave))
}

/** Debounced autosave, same shape as queueStorage.ts's scheduleSave: several changes in quick
 * succession collapse into one write, AUTOSAVE_MS after the last of them — but never later than
 * MAX_WAIT_MS after the first of them. */
export function saveSchedules(schedules: QueueSchedule[]): void {
  pending = schedules
  const now = Date.now()
  firstPendingAt ??= now
  if (timer) clearTimeout(timer)
  const wait = Math.min(AUTOSAVE_MS, firstPendingAt + MAX_WAIT_MS - now)
  timer = setTimeout(flushPending, Math.max(0, wait))
}

/** Saves `schedules` immediately, skipping (and clearing) any pending debounced save — for app
 * shutdown, where there's no time left to wait out the debounce. */
export async function flushSchedules(schedules: QueueSchedule[]): Promise<void> {
  if (timer) clearTimeout(timer)
  timer = null
  pending = null
  firstPendingAt = null
  saveChain = saveChain.catch(() => {}).then(() => writeSchedules(schedules))
  await saveChain
}
