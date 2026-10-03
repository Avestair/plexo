import type { BrowserWindow } from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import type { QueueSchedule, WeeklyRepeat } from '../../shared/types'
import { flushSchedules, loadSchedules, saveSchedules } from '../storage/scheduleStorage'
import type { QueueManager } from './queueManager'

const TICK_MS = 60_000
const DAY_MS = 24 * 60 * 60 * 1000

const WEEKDAYS_BY_GETDAY: (keyof WeeklyRepeat)[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday'
]

function hasAnyWeeklyDay(weekly: WeeklyRepeat | undefined): weekly is WeeklyRepeat {
  return !!weekly && WEEKDAYS_BY_GETDAY.some((day) => weekly[day])
}

/** Rolls `time` forward by exactly 24h, repeatedly, until it's after `now` — never just once, so
 * a schedule that was missed for several days (the app was closed) lands on the next occurrence
 * still ahead of now rather than the first day after the one it missed. */
function advanceDaily(time: number, now: number): number {
  let next = time
  while (next <= now) next += DAY_MS
  return next
}

/** The next time, after `time`, that falls on one of `weekly`'s enabled days at the same
 * time-of-day as `time` — in the user's local time zone (JS Date's local-time getters/setters
 * handle DST, rather than any hand-rolled arithmetic). `time` itself is assumed already past (it
 * just fired), so the search starts at the next calendar day. */
function nextWeeklyOccurrence(time: number, weekly: WeeklyRepeat): number {
  const base = new Date(time)
  for (let offset = 1; offset <= 7; offset++) {
    const candidate = new Date(base)
    candidate.setDate(candidate.getDate() + offset)
    if (weekly[WEEKDAYS_BY_GETDAY[candidate.getDay()]]) return candidate.getTime()
  }
  // Unreachable while hasAnyWeeklyDay(weekly) is true (one of the 7 offsets always matches), but
  // a schedule stuck on `time` forever is a worse failure mode than a schedule that just repeats.
  return time
}

/**
 * Lets a queue be started automatically at a configured time, and optionally paused again later,
 * with optional daily/weekly repetition. One schedule per queue, keyed by queueId. Actually
 * starting/pausing a queue is left entirely to QueueManager (resumeQueue/pauseQueue) — this only
 * ever decides *when* to call them, on a 60s background tick (or on demand via checkNow, which
 * is what lets this be tested without waiting out real time).
 */
export class ScheduleManager {
  private schedules: QueueSchedule[] = []
  private readonly initialization: Promise<void>
  private timer: NodeJS.Timeout | null = null
  /** Guards tick() against running twice at once — it awaits resumeQueue/pauseQueue calls. */
  private ticking = false

  constructor(
    private getWindow: () => BrowserWindow | null,
    private queues: QueueManager
  ) {
    this.initialization = this.restore()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
  }

  private async restore(): Promise<void> {
    this.schedules = await loadSchedules()
  }

  async getSchedules(): Promise<QueueSchedule[]> {
    await this.initialization
    return structuredClone(this.schedules)
  }

  async getSchedule(queueId: string): Promise<QueueSchedule | null> {
    await this.initialization
    const schedule = this.find(queueId)
    return schedule ? structuredClone(schedule) : null
  }

  async setSchedule(
    queueId: string,
    patch: Omit<QueueSchedule, 'queueId'>
  ): Promise<QueueSchedule> {
    await this.initialization
    const schedule: QueueSchedule = { ...patch, queueId }
    const index = this.schedules.findIndex((entry) => entry.queueId === queueId)
    if (index === -1) this.schedules.push(schedule)
    else this.schedules[index] = schedule
    this.persist()
    return structuredClone(schedule)
  }

  async removeSchedule(queueId: string): Promise<void> {
    await this.initialization
    this.schedules = this.schedules.filter((entry) => entry.queueId !== queueId)
    this.persist()
  }

  /** Runs one tick synchronously instead of waiting for the 60s interval — the escape hatch that
   * makes this testable without sleeping out real time. */
  async checkNow(): Promise<void> {
    await this.initialization
    await this.tick()
  }

  /** Flushes any pending debounced save immediately — for app shutdown. */
  async flush(): Promise<void> {
    await this.initialization
    await flushSchedules(structuredClone(this.schedules))
  }

  /** Stops the background tick — for app shutdown, so nothing fires (or keeps the process alive)
   * after the window is gone. */
  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private find(queueId: string): QueueSchedule | undefined {
    return this.schedules.find((entry) => entry.queueId === queueId)
  }

  private persist(): void {
    saveSchedules(structuredClone(this.schedules))
    this.emit()
  }

  private emit(): void {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send(IpcChannels.scheduleUpdated, structuredClone(this.schedules))
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.initialization
      const enabled = this.schedules.filter((schedule) => schedule.enabled)
      if (enabled.length === 0) return

      const allQueues = await this.queues.getQueues()
      const now = Date.now()
      let changed = false

      for (const schedule of enabled) {
        const queue = allQueues.find((entry) => entry.id === schedule.queueId)
        if (!queue) continue // the queue it targets is gone — nothing to drive

        let queueIsActive = queue.status === 'active'
        // Whether this tick has carried out the last action this occurrence has pending: the
        // start if there's no sleepTime to wait for, otherwise the sleep. Once true, the
        // schedule is done with this occurrence and rolls forward (or disables) below.
        let lastActionFired = false

        if (schedule.startTime !== null && schedule.startTime <= now && !queueIsActive) {
          await this.queues.resumeQueue(schedule.queueId)
          queueIsActive = true
          changed = true
          if (schedule.sleepTime == null) lastActionFired = true
        }

        if (schedule.sleepTime != null && schedule.sleepTime <= now && queueIsActive) {
          await this.queues.pauseQueue(schedule.queueId)
          changed = true
          lastActionFired = true
        }

        if (lastActionFired) {
          this.rollForward(schedule, now)
          changed = true
        }
      }

      if (changed) this.persist()
    } finally {
      this.ticking = false
    }
  }

  /** After a schedule fires its last pending action for this occurrence: advances it to the next
   * one (daily or weekly repeat), or disables it (leaving it in place, not deleted, so the user
   * can re-enable/re-time it later) if it doesn't repeat. */
  private rollForward(schedule: QueueSchedule, now: number): void {
    if (schedule.repeatDaily) {
      if (schedule.startTime !== null) schedule.startTime = advanceDaily(schedule.startTime, now)
      if (schedule.sleepTime != null) schedule.sleepTime = advanceDaily(schedule.sleepTime, now)
      return
    }
    if (hasAnyWeeklyDay(schedule.repeatWeekly)) {
      const weekly = schedule.repeatWeekly
      if (schedule.startTime !== null) {
        schedule.startTime = nextWeeklyOccurrence(schedule.startTime, weekly)
      }
      if (schedule.sleepTime != null) {
        schedule.sleepTime = nextWeeklyOccurrence(schedule.sleepTime, weekly)
      }
      return
    }
    schedule.enabled = false
  }
}
