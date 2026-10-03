import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import type { DownloadState, DownloadUpdate, HistoryEntry } from '../../shared/types'
import type { DownloadManager } from '../download/downloadManager'
import type { QueueManager } from '../queue/queueManager'
import { flushHistory, loadHistory, scheduleSaveHistory } from '../storage/historyStorage'
import { testKnobs } from '../testKnobs'

function terminalStatus(state: DownloadState): HistoryEntry['status'] | null {
  if (state.status === 'completed') return 'completed'
  if (state.status === 'error') return 'failed'
  if (state.status === 'cancelled') return 'cancelled'
  return null
}

/**
 * Records one HistoryEntry whenever any download — ad-hoc or queue-driven — reaches a terminal
 * state, by hooking DownloadManager.onUpdate the same way QueueManager and BandwidthManager
 * already do (see queueManager.ts's constructor and bandwidthManager.ts's module doc for the two
 * prior consumers of that stream) rather than re-detecting completion itself. This is the third
 * consumer, and deliberately never touches DownloadManager or QueueManager's own state — only
 * reads what they already publish.
 *
 * Source attribution (ad-hoc vs. queue) follows BandwidthManager's queueIdByDownload pattern
 * exactly, down to the same ordering note: QueueManager subscribes to DownloadManager.onUpdate in
 * its own constructor before this manager exists, so QueueManager's listener always runs first for
 * any one event, including the terminal one where QueueManager clears its own `active` field as
 * part of handling it. Keying off a download-id map populated by onActiveChanged (rather than
 * asking QueueManager's current active download "right now") means this manager's listener order
 * relative to QueueManager's doesn't matter.
 *
 * Checksum timing: when an ExpectedChecksum is attached, DownloadManager pushes one 'completed'
 * update with checksumStatus 'verifying', then a second once the hash settles (see
 * DownloadManager.verifyChecksum). Recording on the first would capture 'verifying' forever, so a
 * download whose checksum hasn't settled yet is held in `pendingChecksum` until the follow-up
 * update arrives (QueueManager does the equivalent to avoid freeing the queue slot too early — see
 * its handleDownloadUpdate). If the app quits before that follow-up arrives (killed mid-hash on a
 * very large file), no entry is recorded for that download — an accepted gap given how narrow the
 * window is, rather than recording a known-incomplete checksum result.
 */
export class HistoryManager {
  private entries: HistoryEntry[] = []
  private readonly initialization: Promise<void>
  private readonly queueIdByDownload = new Map<string, string>()
  /** Download ids already recorded — a terminal state is only ever recorded once, even if
   * DownloadManager pushes further updates at the same status (e.g. a later unrelated field). */
  private readonly recorded = new Set<string>()
  private readonly pendingChecksum = new Set<string>()
  private readonly unsubscribeActive: () => void
  private readonly unsubscribeDownloads: () => void
  private disposed = false

  constructor(
    private getWindow: () => BrowserWindow | null,
    private downloads: DownloadManager,
    private queues: QueueManager
  ) {
    this.initialization = this.restore()
    this.unsubscribeActive = this.queues.onActiveChanged((active) => {
      if (active) this.queueIdByDownload.set(active.downloadId, active.queueId)
    })
    this.unsubscribeDownloads = this.downloads.onUpdate((update) => this.handleUpdate(update))
  }

  private async restore(): Promise<void> {
    this.entries = await loadHistory()
  }

  async getAll(): Promise<HistoryEntry[]> {
    await this.initialization
    return structuredClone(this.entries)
  }

  /** Case-insensitive substring match against fileName/url, optionally narrowed to one status —
   * small enough a scale (see historyStorage.ts's cap) that a plain filter needs no search index. */
  async search(query: string, statusFilter?: HistoryEntry['status']): Promise<HistoryEntry[]> {
    await this.initialization
    const needle = query.trim().toLowerCase()
    const matches = this.entries.filter((entry) => {
      if (statusFilter && entry.status !== statusFilter) return false
      if (!needle) return true
      return (
        entry.fileName.toLowerCase().includes(needle) || entry.url.toLowerCase().includes(needle)
      )
    })
    return structuredClone(matches)
  }

  async clear(): Promise<void> {
    await this.initialization
    this.entries = []
    this.persist()
  }

  /** Flushes any pending debounced save immediately — for app shutdown. */
  async flush(): Promise<void> {
    await this.initialization
    await flushHistory(structuredClone(this.entries))
  }

  /** Unsubscribes from QueueManager/DownloadManager — for app shutdown, same as
   * BandwidthManager.dispose. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeActive()
    this.unsubscribeDownloads()
  }

  private handleUpdate(update: DownloadUpdate): void {
    const { state } = update
    const status = terminalStatus(state)
    if (!status || this.recorded.has(state.id)) return
    if (state.checksumStatus === 'verifying') {
      this.pendingChecksum.add(state.id)
      return
    }
    this.pendingChecksum.delete(state.id)
    this.recorded.add(state.id)
    void this.record(state, status)
  }

  private async record(state: DownloadState, status: HistoryEntry['status']): Promise<void> {
    await this.initialization
    const queueId = this.queueIdByDownload.get(state.id)
    const entry: HistoryEntry = {
      id: randomUUID(),
      url: state.url,
      fileName: state.fileName,
      destinationPath: state.destinationPath,
      size: state.totalBytes || state.bytesDownloaded,
      status,
      startedAt: state.startedAt,
      finishedAt: state.completedAt ?? Date.now(),
      source: queueId ? 'queue' : 'adhoc'
    }
    if (queueId) {
      entry.queueId = queueId
      entry.queueName = this.queues.getQueueName(queueId)
    }
    if (state.expectedChecksum) entry.checksum = state.expectedChecksum
    if (state.checksumStatus) entry.checksumStatus = state.checksumStatus
    if (state.checksumComputedHex) entry.checksumComputedHex = state.checksumComputedHex
    if (state.error) entry.error = state.error

    // Newest first, capped in memory too (not just at write time — see historyStorage.ts's
    // capEntries) so a long session's entry list and every push to the window stay bounded.
    this.entries = [entry, ...this.entries].slice(0, testKnobs.historyCapEntries)
    this.persist()
  }

  private persist(): void {
    scheduleSaveHistory(structuredClone(this.entries))
    this.emit()
  }

  private emit(): void {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send(IpcChannels.historyUpdated, structuredClone(this.entries))
  }
}
