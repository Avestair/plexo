import type { BrowserWindow } from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import type {
  BandwidthLimit,
  BandwidthResetSchedule,
  DownloadUpdate,
  QueueBandwidthSettings,
  QueueBandwidthUsage
} from '../../shared/types'
import type { DownloadManager } from '../download/downloadManager'
import { loadSettings, saveSettings } from '../settings'
import {
  flushBandwidthSettings,
  loadBandwidthSettings,
  scheduleSaveBandwidthSettings
} from '../storage/bandwidthStorage'
import type { QueueManager } from './queueManager'

const TICK_MS = 60_000
const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

/** How close to its traffic cap a queue has to get before the renderer shows a warning (see
 * QueueBandwidthUsage.usedBytes/maxTrafficBytes and useBandwidth). 90%: close enough to be
 * useful notice, far enough not to nag for most of a cap's life. */
export const NEAR_CAP_RATIO = 0.9

function nextMonthlyBoundary(time: number): number {
  const date = new Date(time)
  date.setMonth(date.getMonth() + 1)
  return date.getTime()
}

/** Rolls `lastResetAt` forward to the latest reset boundary at or before `now`, one period at a
 * time — the same missed-occurrences loop as scheduleManager.ts's advanceDaily, generalized to
 * all three periods (monthly via the calendar month, not a fixed 30-day window, per
 * Date.setMonth). Returns `lastResetAt` unchanged if no boundary has passed yet. */
function advanceReset(lastResetAt: number, schedule: BandwidthResetSchedule, now: number): number {
  let next = lastResetAt
  for (;;) {
    const candidate =
      schedule === 'daily'
        ? next + DAY_MS
        : schedule === 'weekly'
          ? next + WEEK_MS
          : nextMonthlyBoundary(next)
    if (candidate > now) return next
    next = candidate
  }
}

export interface BandwidthGate {
  isQueueCapped(queueId: string): boolean
}

/**
 * Global and per-queue download speed limits, plus a per-queue total-traffic cap with an
 * optional daily/weekly/monthly reset. The actual throttling is left entirely to
 * download/bandwidth.ts's RateLimiter (one shared instance owned by DownloadManager) — this only
 * ever decides *what number* that limiter should be running at, and *whether* a queue's cap has
 * been reached, the same decide/seam split the rest of the queue system follows (see
 * systemActions.ts's module doc).
 *
 * Architecture notes:
 * - DownloadManager runs exactly one download at a time, ad-hoc or queue-driven (see its
 *   isIdle()/hasActiveDownload() — Plexo's single-flight design from Phase 1). That means there
 *   is only ever one transfer to throttle at once, so one DownloadManager-wide RateLimiter,
 *   reconfigured whenever the effective limit changes, already satisfies both "every chunk of
 *   one download shares a limit" and "every concurrent download system-wide shares the global
 *   limit" — there is never a second simultaneous download that would need a limiter of its own.
 * - Which number is "effective" depends on whether the one running download currently belongs
 *   to a queue with its own override: QueueManager.onActiveChanged reports that (see `current`
 *   below); everything else comes from AppSettings.globalMaxSpeedBytesPerSec and this manager's
 *   own per-queue settings. The effective limit is recomputed and re-pushed into
 *   DownloadManager.setSpeedLimit on every change to any of those — including mid-download, so a
 *   limit changed live takes effect without restarting the transfer (RateLimiter.setLimit is
 *   itself live-applied; see its doc).
 * - Traffic usage is tracked per queue as the *delta* of the active download's bytesDownloaded
 *   since this manager last credited it (see BandwidthLimit's accounting doc in shared/types.ts)
 *   — folded in off the same DownloadManager.onUpdate stream QueueManager itself watches, so no
 *   polling and no duplicated byte-counting logic.
 * - Cap enforcement: QueueManager.nextCandidate() asks isQueueCapped() before starting a queue's
 *   next pending item. The item already running when a cap is crossed is left to finish (or be
 *   paused/cancelled by the user) rather than aborted mid-transfer — aborting it would throw away
 *   partial progress for a stop that is purely a traffic bookkeeping decision, not a failure, and
 *   "stop starting new ones" is what the spec asks for. QueueManager reflects this as
 *   Queue.capReached (distinct from a user's own pause) rather than changing `status`, since the
 *   queue is still logically 'active' — it only resumes starting items once usage resets.
 */
export class BandwidthManager implements BandwidthGate {
  private entries: QueueBandwidthSettings[] = []
  private globalLimit = 0
  private readonly initialization: Promise<void>
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private disposed = false
  /** The queue (if any) currently holding the one download slot, and which download id it is —
   * kept in step by QueueManager.onActiveChanged. Read for `effectiveSpeedLimit` (which limit
   * applies *right now*); usage crediting below deliberately does not depend on it — see
   * `queueIdByDownload`. */
  private current: { queueId: string; downloadId: string } | null = null
  /**
   * Every download id QueueManager has ever told this manager belongs to a queue, kept past the
   * point QueueManager itself moves on (`current` goes back to null). This exists because
   * QueueManager subscribes to DownloadManager.onUpdate in its own constructor, before
   * BandwidthManager is even created, so for any one update event QueueManager's own listener
   * always runs first — including the *terminal* ('completed'/'error'/'cancelled') update, where
   * QueueManager clears its active download synchronously as part of handling that very event.
   * If usage crediting below keyed off `current` instead, it would see `current` already null by
   * the time it's this manager's turn to process that last, most-important update and lose the
   * final bytes. Keying off this map instead means ordering between the two listeners doesn't
   * matter. Entries are small (a queueId string per id) and only accumulate for the life of the
   * app session — not persisted, and not worth pruning for how little memory it is.
   */
  private readonly queueIdByDownload = new Map<string, string>()
  /** Per download id: bytesDownloaded last folded into its queue's usage — lets the next update
   * take a delta instead of double-counting (see BandwidthLimit's doc). */
  private readonly lastCreditedBytes = new Map<string, number>()
  private readonly unsubscribeActive: () => void
  private readonly unsubscribeDownloads: () => void

  constructor(
    private getWindow: () => BrowserWindow | null,
    private queues: QueueManager,
    private downloads: DownloadManager
  ) {
    this.initialization = this.restore()
    this.unsubscribeActive = this.queues.onActiveChanged((active) =>
      this.handleActiveChanged(active)
    )
    this.unsubscribeDownloads = this.downloads.onUpdate((update) =>
      this.handleDownloadUpdate(update)
    )
    this.timer = setInterval(() => void this.tick(), TICK_MS)
  }

  private async restore(): Promise<void> {
    this.entries = await loadBandwidthSettings()
    const settings = await loadSettings()
    this.globalLimit = settings.globalMaxSpeedBytesPerSec ?? 0
    this.pushEffectiveLimit()
  }

  // --- global limit -----------------------------------------------------------------------------

  async getGlobalLimit(): Promise<number> {
    await this.initialization
    return this.globalLimit
  }

  async setGlobalLimit(bytesPerSec: number): Promise<void> {
    await this.initialization
    this.globalLimit = Number.isFinite(bytesPerSec) && bytesPerSec > 0 ? bytesPerSec : 0
    await saveSettings({ globalMaxSpeedBytesPerSec: this.globalLimit || undefined })
    this.pushEffectiveLimit()
    this.emitUsage()
  }

  // --- per-queue limit --------------------------------------------------------------------------

  async getQueueLimit(queueId: string): Promise<QueueBandwidthSettings | null> {
    await this.initialization
    const entry = this.find(queueId)
    return entry ? structuredClone(entry) : null
  }

  async getQueueLimits(): Promise<QueueBandwidthSettings[]> {
    await this.initialization
    return structuredClone(this.entries)
  }

  async setQueueLimit(
    queueId: string,
    patch: Omit<QueueBandwidthSettings, 'queueId'>
  ): Promise<QueueBandwidthSettings> {
    await this.initialization
    const existing = this.find(queueId)
    const limit: BandwidthLimit | undefined = patch.limit
      ? {
          ...patch.limit,
          usedBytes: patch.limit.usedBytes || existing?.limit?.usedBytes || 0,
          lastResetAt: patch.limit.lastResetAt ?? existing?.limit?.lastResetAt ?? Date.now()
        }
      : undefined
    const entry: QueueBandwidthSettings = { queueId, useGlobalLimit: patch.useGlobalLimit, limit }
    const index = this.entries.findIndex((item) => item.queueId === queueId)
    if (index === -1) this.entries.push(entry)
    else this.entries[index] = entry
    this.persist()
    if (this.current?.queueId === queueId) this.pushEffectiveLimit()
    this.queues.requestTick() // a raised/removed cap may free a queue stuck waiting on it
    return structuredClone(entry)
  }

  async removeQueueLimit(queueId: string): Promise<void> {
    await this.initialization
    this.entries = this.entries.filter((entry) => entry.queueId !== queueId)
    this.persist()
    if (this.current?.queueId === queueId) this.pushEffectiveLimit()
    this.queues.requestTick()
  }

  // --- usage --------------------------------------------------------------------------------

  async getUsage(): Promise<QueueBandwidthUsage[]> {
    await this.initialization
    return this.entries.map((entry) => this.usageOf(entry))
  }

  private usageOf(entry: QueueBandwidthSettings): QueueBandwidthUsage {
    const limit = entry.limit
    return {
      queueId: entry.queueId,
      usedBytes: limit?.usedBytes ?? 0,
      maxTrafficBytes: limit?.maxTrafficBytes,
      capReached: this.isQueueCapped(entry.queueId),
      resetSchedule: limit?.resetSchedule,
      lastResetAt: limit?.lastResetAt
    }
  }

  /** The bandwidth gate QueueManager consults from nextCandidate() — pure and synchronous. Reads
   * only what restore() has already loaded; a queue can't be 'active' before startup has
   * finished loading everything else it needs anyway, so this never races restore(). */
  isQueueCapped(queueId: string): boolean {
    const limit = this.find(queueId)?.limit
    if (!limit?.maxTrafficBytes) return false
    return limit.usedBytes >= limit.maxTrafficBytes
  }

  /** Runs one reset-check tick synchronously instead of waiting for the 60s interval — the
   * escape hatch that makes this testable without sleeping out real time, same as
   * ScheduleManager.checkNow. */
  async checkNow(): Promise<void> {
    await this.initialization
    await this.tick()
  }

  /** Flushes any pending debounced save immediately — for app shutdown. */
  async flush(): Promise<void> {
    await this.initialization
    await flushBandwidthSettings(structuredClone(this.entries))
  }

  /** Stops the background tick and unsubscribes from QueueManager/DownloadManager — for app
   * shutdown. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.unsubscribeActive()
    this.unsubscribeDownloads()
  }

  private find(queueId: string): QueueBandwidthSettings | undefined {
    return this.entries.find((entry) => entry.queueId === queueId)
  }

  private persist(): void {
    scheduleSaveBandwidthSettings(structuredClone(this.entries))
    this.emitUsage()
  }

  private emitUsage(): void {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send(
      IpcChannels.bandwidthUpdated,
      this.entries.map((entry) => this.usageOf(entry))
    )
  }

  /** The speed limit that should apply to the one download currently running: when the active
   * queue opts out of the global limit (useGlobalLimit: false), its own maxSpeedBytesPerSec
   * applies — unlimited if it hasn't set one, since opting out means exactly that, not "fall
   * back to global after all". Otherwise (useGlobalLimit: true, no queue active, or no entry for
   * this queue) the global limit applies, which is also all an ad-hoc download — belonging to no
   * queue — ever gets. */
  private effectiveSpeedLimit(): number {
    if (this.current) {
      const entry = this.find(this.current.queueId)
      if (entry && !entry.useGlobalLimit) {
        return entry.limit?.maxSpeedBytesPerSec ?? 0
      }
    }
    return this.globalLimit
  }

  private pushEffectiveLimit(): void {
    this.downloads.setSpeedLimit(this.effectiveSpeedLimit())
  }

  private handleActiveChanged(active: { queueId: string; downloadId: string } | null): void {
    this.current = active
    if (active) this.queueIdByDownload.set(active.downloadId, active.queueId)
    this.pushEffectiveLimit()
  }

  private handleDownloadUpdate(update: DownloadUpdate): void {
    // Only folds bytes into a queue's usage while this download id is one QueueManager has told
    // us belongs to a queue — see queueIdByDownload's doc for why this, not `current`, is what
    // usage crediting keys off. An ad-hoc download's id was never recorded here, so this is
    // naturally a no-op for it.
    const queueId = this.queueIdByDownload.get(update.state.id)
    if (!queueId) return
    const entry = this.find(queueId)
    if (!entry?.limit?.maxTrafficBytes) {
      // No cap configured — still remember this download's last byte count, so a cap added
      // later starts crediting from here rather than replaying bytes it never watched for.
      this.lastCreditedBytes.set(update.state.id, update.state.bytesDownloaded)
      return
    }
    const last = this.lastCreditedBytes.get(update.state.id) ?? 0
    const delta = update.state.bytesDownloaded - last
    if (delta <= 0) return
    this.lastCreditedBytes.set(update.state.id, update.state.bytesDownloaded)
    const wasCapped = this.isQueueCapped(queueId)
    entry.limit.usedBytes += delta
    this.persist()
    if (!wasCapped && this.isQueueCapped(queueId)) {
      // Just crossed the cap: let QueueManager re-check for startable items right away rather
      // than waiting on whatever event would otherwise trigger its next tick(). The item
      // already running is left alone either way (see class doc).
      this.queues.requestTick()
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.initialization
      const now = Date.now()
      let changed = false
      let anyReset = false
      for (const entry of this.entries) {
        const limit = entry.limit
        if (!limit?.resetSchedule || limit.resetSchedule === 'never') continue
        const lastResetAt = limit.lastResetAt ?? now
        const next = advanceReset(lastResetAt, limit.resetSchedule, now)
        if (next !== lastResetAt) {
          limit.usedBytes = 0
          limit.lastResetAt = next
          changed = true
          anyReset = true
        } else if (limit.lastResetAt === undefined) {
          limit.lastResetAt = lastResetAt
          changed = true
        }
      }
      if (changed) this.persist()
      // A reset may have freed a queue that was stuck at its cap — let QueueManager look again.
      if (anyReset) this.queues.requestTick()
    } finally {
      this.ticking = false
    }
  }
}
