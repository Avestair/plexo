import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import type {
  BatchAddResult,
  DownloadUpdate,
  Queue,
  QueueItem,
  SkippedBatchUrl,
  StartDownloadRequest
} from '../../shared/types'
import type { DownloadManager } from '../download/downloadManager'
import { getDefaultDownloadsDir } from '../download/paths'
import { probeUrl } from '../download/probe'
import type { NetworkMonitor } from '../network/interfaces'
import { loadQueues, flushQueues, scheduleSave } from '../storage/queueStorage'

/** The one queue item currently being downloaded, if any — Plexo runs one managed download at a
 * time (see DownloadManager.isIdle), so only one queue item downloads at once, across every
 * queue. */
interface ActiveDownload {
  queueId: string
  itemId: string
  downloadId: string
}

function fileNameFromUrl(url: string): string {
  try {
    const { pathname } = new URL(url)
    const last = decodeURIComponent(pathname.split('/').filter(Boolean).pop() ?? '')
    return last || 'download'
  } catch {
    return 'download'
  }
}

/** What a batch import treats as "obviously invalid": not parseable as a URL at all, or parseable
 * but not http(s) — ftp://, a bare file path, or a stray non-URL line typed into the textarea. The
 * single-add path (addDownload) deliberately stays looser (any non-blank string, same as always)
 * since that one always was — this stricter check only gates the new batch path, to keep a typo'd
 * line from silently becoming a doomed queue item instead of a reported skip. */
function isImportableUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function buildQueueItem(url: string): QueueItem {
  return {
    id: randomUUID(),
    url,
    fileName: fileNameFromUrl(url),
    status: 'pending',
    progress: 0,
    size: 0,
    downloadedSize: 0,
    speedBytesPerSec: 0,
    timeRemainingSec: 0,
    addedAt: Date.now()
  }
}

/**
 * Named, ordered lists of downloads the user wants run one after another. CRUD lives here;
 * actually fetching a URL is left entirely to DownloadManager — this only ever calls start(),
 * pause(), resume() and remove() on it, and watches its updates (via onUpdate) to keep each
 * item's progress in step with whichever one is currently running.
 */
export class QueueManager {
  private queues: Queue[] = []
  private readonly initialization: Promise<void>
  private active: ActiveDownload | null = null
  /** Guards tick() against running twice at once — it awaits a probe and a start(), both async. */
  private processing = false
  /** Watchers of a queue's status becoming 'completed' (the system-action manager) — see
   * onQueueCompleted. */
  private readonly completionListeners = new Set<(queue: Queue) => void>()
  /** Watchers of which queue (if any) currently holds the one download slot (the bandwidth
   * manager, to know which queue's usage/speed-limit applies) — see onActiveChanged. */
  private readonly activeChangeListeners = new Set<
    (active: { queueId: string; downloadId: string } | null) => void
  >()
  /** Asked, for each active queue, whether its traffic cap has been reached — wired up by the
   * bandwidth manager after construction (see attachBandwidthGate), since it in turn depends on
   * this manager's events. Defaults to "never capped" so the queue system works unchanged before
   * that's attached (and in tests that construct a QueueManager on its own). */
  private bandwidthGate: { isQueueCapped: (queueId: string) => boolean } = {
    isQueueCapped: () => false
  }

  constructor(
    private getWindow: () => BrowserWindow | null,
    private downloads: DownloadManager,
    private networks: NetworkMonitor
  ) {
    this.downloads.onUpdate((update) => this.handleDownloadUpdate(update))
    this.initialization = this.restore()
  }

  private async restore(): Promise<void> {
    this.queues = await loadQueues()
    // An item left 'downloading' from before a restart has nothing backing it any more — the
    // download itself was never persisted under the queue's control. Put it back in line.
    for (const queue of this.queues) {
      for (const item of queue.items) {
        if (item.status === 'downloading') {
          item.status = 'pending'
          item.speedBytesPerSec = 0
          item.timeRemainingSec = 0
        }
      }
      this.recomputeProgress(queue)
    }
    void this.tick()
  }

  async getQueues(): Promise<Queue[]> {
    await this.initialization
    return structuredClone(this.queues)
  }

  async createQueue(name: string, description?: string): Promise<Queue> {
    await this.initialization
    const queue: Queue = {
      id: randomUUID(),
      name: name.trim() || 'Untitled queue',
      createdAt: Date.now(),
      items: [],
      status: 'idle',
      totalProgress: 0
    }
    const trimmedDescription = description?.trim()
    if (trimmedDescription) queue.description = trimmedDescription
    this.queues.push(queue)
    this.persist()
    return structuredClone(queue)
  }

  async deleteQueue(queueId: string): Promise<void> {
    await this.initialization
    if (this.active?.queueId === queueId) await this.stopActive()
    this.queues = this.queues.filter((queue) => queue.id !== queueId)
    this.persist()
  }

  async updateQueueName(queueId: string, name: string): Promise<void> {
    await this.initialization
    const queue = this.find(queueId)
    const trimmed = name.trim()
    if (!queue || !trimmed) return
    queue.name = trimmed
    this.persist()
  }

  async addDownload(queueId: string, url: string): Promise<QueueItem> {
    await this.initialization
    const queue = this.find(queueId)
    if (!queue) throw new Error('Queue not found')
    const trimmed = url.trim()
    if (!trimmed) throw new Error('Enter a URL')
    const item = buildQueueItem(trimmed)
    queue.items.push(item)
    // A queue that had finished has somewhere new to go.
    if (queue.status === 'completed') queue.status = 'idle'
    this.recomputeProgress(queue)
    this.persist()
    void this.tick()
    return structuredClone(item)
  }

  /**
   * Adds many URLs to a queue in one go — the batch-import path (a pasted list, or a file read
   * client-side by the dialog picker). Validates and dedupes before touching the queue at all,
   * then applies every survivor and persists exactly once, so importing a few hundred lines
   * doesn't trigger a few hundred debounced saves.
   *
   * Dedup policy (documented since it's a judgment call): two kinds of duplicate are skipped —
   * a URL repeated later in the same batch, and a URL already present anywhere in the target
   * queue (pending, downloading, or already completed) — both compared as the exact trimmed
   * string, not a semantic normalization (so `.../a` and `.../a/` are treated as different URLs,
   * same as the single-add path always has). Comparing against the whole queue, not just its
   * pending items, means re-pasting a list that was already fully downloaded reports every line
   * as a duplicate rather than queuing a second copy of each.
   */
  async addDownloads(queueId: string, urls: string[]): Promise<BatchAddResult> {
    await this.initialization
    const queue = this.find(queueId)
    if (!queue) throw new Error('Queue not found')

    const seen = new Set(queue.items.map((item) => item.url))
    const added: QueueItem[] = []
    const skipped: SkippedBatchUrl[] = []

    for (const raw of urls) {
      const trimmed = raw.trim()
      if (!trimmed) continue // blank lines are ignored, not reported
      if (seen.has(trimmed)) {
        skipped.push({ url: trimmed, reason: 'duplicate' })
        continue
      }
      if (!isImportableUrl(trimmed)) {
        skipped.push({ url: trimmed, reason: 'invalid' })
        continue
      }
      const item = buildQueueItem(trimmed)
      queue.items.push(item)
      added.push(item)
      seen.add(trimmed)
    }

    if (added.length > 0) {
      if (queue.status === 'completed') queue.status = 'idle'
      this.recomputeProgress(queue)
      this.persist()
      void this.tick()
    }

    return { added: structuredClone(added), skipped }
  }

  async removeDownload(queueId: string, itemId: string): Promise<void> {
    await this.initialization
    const queue = this.find(queueId)
    if (!queue) return
    if (this.active?.queueId === queueId && this.active.itemId === itemId) {
      await this.stopActive()
    }
    queue.items = queue.items.filter((item) => item.id !== itemId)
    this.recomputeProgress(queue)
    this.persist()
  }

  async pauseQueue(queueId: string): Promise<void> {
    await this.initialization
    const queue = this.find(queueId)
    if (!queue || queue.status !== 'active') return
    queue.status = 'paused'
    if (this.active?.queueId === queueId) await this.downloads.pause(this.active.downloadId)
    this.persist()
  }

  async resumeQueue(queueId: string): Promise<void> {
    await this.initialization
    const queue = this.find(queueId)
    if (!queue || queue.status === 'completed') return
    queue.status = 'active'
    if (this.active?.queueId === queueId) this.downloads.resume(this.active.downloadId)
    this.persist()
    void this.tick()
  }

  async pauseItem(queueId: string, itemId: string): Promise<void> {
    await this.initialization
    const queue = this.find(queueId)
    const item = queue?.items.find((entry) => entry.id === itemId)
    if (!queue || !item) return
    if (this.active?.queueId === queueId && this.active.itemId === itemId) {
      await this.downloads.pause(this.active.downloadId)
      return
    }
    if (item.status !== 'pending') return
    item.status = 'paused'
    this.recomputeProgress(queue)
    this.persist()
  }

  async resumeItem(queueId: string, itemId: string): Promise<void> {
    await this.initialization
    const queue = this.find(queueId)
    const item = queue?.items.find((entry) => entry.id === itemId)
    if (!queue || !item) return
    if (this.active?.queueId === queueId && this.active.itemId === itemId) {
      this.downloads.resume(this.active.downloadId)
      return
    }
    if (item.status !== 'paused') return
    item.status = 'pending'
    this.recomputeProgress(queue)
    this.persist()
    void this.tick()
  }

  async cancelItem(queueId: string, itemId: string): Promise<void> {
    await this.initialization
    const queue = this.find(queueId)
    const item = queue?.items.find((entry) => entry.id === itemId)
    if (!queue || !item) return
    if (this.active?.queueId === queueId && this.active.itemId === itemId) {
      await this.stopActive()
    }
    if (item.status !== 'completed') {
      item.status = 'failed'
      item.error = 'Cancelled'
      item.speedBytesPerSec = 0
      item.timeRemainingSec = 0
    }
    this.recomputeProgress(queue)
    this.persist()
    void this.tick()
  }

  async reorderItems(queueId: string, itemIds: string[]): Promise<void> {
    await this.initialization
    const queue = this.find(queueId)
    if (!queue) return
    const byId = new Map(queue.items.map((item) => [item.id, item]))
    const reordered: QueueItem[] = []
    for (const id of itemIds) {
      const item = byId.get(id)
      if (item) reordered.push(item)
    }
    // Anything the caller left out (it shouldn't, but a stale renderer could) keeps its place
    // rather than silently vanishing.
    for (const item of queue.items) {
      if (!itemIds.includes(item.id)) reordered.push(item)
    }
    queue.items = reordered
    this.persist()
  }

  /** Flushes any pending debounced save immediately — for app shutdown. */
  async flush(): Promise<void> {
    await this.initialization
    await flushQueues(structuredClone(this.queues))
  }

  /** Lets other main-process code (the system-action manager) watch a queue transitioning to
   * 'completed' — the same pattern as DownloadManager.onUpdate. Returns a function that
   * unsubscribes. */
  onQueueCompleted(listener: (queue: Queue) => void): () => void {
    this.completionListeners.add(listener)
    return () => this.completionListeners.delete(listener)
  }

  /** Lets the bandwidth manager watch which queue (if any) currently holds the download slot —
   * same pattern as onQueueCompleted. Fires once right away with the current value, and again
   * every time it changes. Returns a function that unsubscribes. */
  onActiveChanged(
    listener: (active: { queueId: string; downloadId: string } | null) => void
  ): () => void {
    this.activeChangeListeners.add(listener)
    listener(
      this.active ? { queueId: this.active.queueId, downloadId: this.active.downloadId } : null
    )
    return () => this.activeChangeListeners.delete(listener)
  }

  /** Lets the bandwidth manager decide, for a given queue, whether its traffic cap has been
   * reached — called from nextCandidate() before starting that queue's next item. Set once at
   * startup (see main/ipc/handlers.ts); the default gate never caps anything. */
  attachBandwidthGate(gate: { isQueueCapped: (queueId: string) => boolean }): void {
    this.bandwidthGate = gate
  }

  /** Runs tick() on demand from outside — what lets the bandwidth manager re-check for
   * startable items right after a traffic-cap reset, without waiting for some other queue event
   * to happen to trigger one. */
  requestTick(): void {
    void this.tick()
  }

  private find(queueId: string): Queue | undefined {
    return this.queues.find((queue) => queue.id === queueId)
  }

  private setActive(active: ActiveDownload | null): void {
    this.active = active
    for (const listener of this.activeChangeListeners) {
      listener(active ? { queueId: active.queueId, downloadId: active.downloadId } : null)
    }
  }

  private recomputeProgress(queue: Queue): void {
    const wasCompleted = queue.status === 'completed'
    queue.totalProgress = queue.items.length
      ? Math.round(queue.items.reduce((sum, item) => sum + item.progress, 0) / queue.items.length)
      : 0
    if (
      queue.status === 'active' &&
      queue.items.length > 0 &&
      queue.items.every((item) => item.status === 'completed' || item.status === 'failed')
    ) {
      queue.status = 'completed'
    }
    // Only the transition into 'completed' fires — not a queue that was already completed (e.g.
    // another item's progress tick recomputing this), and not the reopen back to 'idle' that
    // addDownload does when more URLs are added to a finished queue.
    if (!wasCompleted && queue.status === 'completed') {
      const snapshot = structuredClone(queue)
      for (const listener of this.completionListeners) listener(snapshot)
    }
  }

  private persist(): void {
    scheduleSave(structuredClone(this.queues))
    this.emit()
  }

  private emit(): void {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send(IpcChannels.queueUpdated, structuredClone(this.queues))
  }

  /** Stops whatever is running for the active item (a pause or cancel underneath it, or the
   * queue/item being deleted) and frees the slot for the next one. */
  private async stopActive(): Promise<void> {
    if (!this.active) return
    const { downloadId } = this.active
    this.setActive(null)
    await this.downloads.remove(downloadId)
  }

  /** The first pending item of the first active, not-capped queue, in queue and item order —
   * queues are processed FIFO, and so is each queue's own list. Also keeps each active queue's
   * `capReached` flag in step with the bandwidth gate as a side effect, so the UI can tell a
   * cap-stopped queue apart from one the user paused even when nothing else changes it. */
  private nextCandidate(): { queue: Queue; item: QueueItem } | undefined {
    let changed = false
    let candidate: { queue: Queue; item: QueueItem } | undefined
    for (const queue of this.queues) {
      if (queue.status !== 'active') continue
      const capped = this.bandwidthGate.isQueueCapped(queue.id)
      if (!!queue.capReached !== capped) {
        queue.capReached = capped
        changed = true
      }
      if (capped || candidate) continue
      const item = queue.items.find((entry) => entry.status === 'pending')
      if (item) candidate = { queue, item }
    }
    if (changed) this.persist()
    return candidate
  }

  /** Starts the next queued item, if the download slot is free. Bounded by the total item count
   * so a run of probe/start failures can't loop forever. */
  private async tick(): Promise<void> {
    if (this.processing || this.active) return
    this.processing = true
    try {
      let budget = this.queues.reduce((sum, queue) => sum + queue.items.length, 0)
      while (budget-- > 0 && !this.active) {
        if (!this.downloads.isIdle()) return // an ad-hoc download (or another queue) has the slot
        const next = this.nextCandidate()
        if (!next) return
        const { queue, item } = next
        try {
          const probe = await probeUrl(item.url)
          const available = await this.networks.refresh()
          if (available.length === 0) throw new Error('No network connection available')
          const request: StartDownloadRequest = {
            url: probe.finalUrl,
            destinationDir: getDefaultDownloadsDir(),
            suggestedFileName: probe.suggestedFileName || item.fileName,
            totalBytes: probe.totalBytes ?? 0,
            supportsRanges: probe.supportsRanges,
            interfaceIds: available.map((iface) => iface.id),
            etag: probe.etag,
            lastModified: probe.lastModified
          }
          const downloadId = await this.downloads.start(request)
          this.setActive({ queueId: queue.id, itemId: item.id, downloadId })
          item.status = 'downloading'
          item.fileName = request.suggestedFileName
          item.size = request.totalBytes
          item.error = undefined
          this.recomputeProgress(queue)
          this.persist()
          return
        } catch (error) {
          if (!this.downloads.isIdle()) return // lost the race to another download — try later
          item.status = 'failed'
          item.error = error instanceof Error ? error.message : String(error)
          this.recomputeProgress(queue)
          this.persist()
        }
      }
    } finally {
      this.processing = false
    }
  }

  /** Keeps the active item's progress in step with its download, and moves the queue along once
   * it finishes — reusing exactly what DownloadManager already pushes to the window (see
   * DownloadManager.onUpdate), never polling or duplicating its state. */
  private handleDownloadUpdate(update: DownloadUpdate): void {
    const { state } = update
    if (!this.active || this.active.downloadId !== state.id) {
      // Not the item this manager is tracking. If nothing is active here and a download just
      // ended, the slot it held may now be free for a queued item.
      if (
        !this.active &&
        (state.status === 'completed' || state.status === 'error' || state.status === 'cancelled')
      ) {
        void this.tick()
      }
      return
    }

    const queue = this.find(this.active.queueId)
    const item = queue?.items.find((entry) => entry.id === this.active!.itemId)
    if (!queue || !item) {
      this.setActive(null)
      void this.tick()
      return
    }

    item.downloadedSize = state.bytesDownloaded
    item.size = state.totalBytes || item.size
    item.speedBytesPerSec = state.speedBytesPerSec
    item.progress =
      state.totalBytes > 0
        ? Math.min(100, Math.round((state.bytesDownloaded / state.totalBytes) * 100))
        : 0
    item.timeRemainingSec =
      state.speedBytesPerSec > 0 && state.totalBytes > 0
        ? Math.max(
            0,
            Math.round((state.totalBytes - state.bytesDownloaded) / state.speedBytesPerSec)
          )
        : 0

    let done = false
    switch (state.status) {
      case 'downloading':
        item.status = 'downloading'
        break
      case 'paused':
        item.status = 'paused'
        item.speedBytesPerSec = 0
        item.timeRemainingSec = 0
        break
      case 'completed':
        item.status = 'completed'
        item.progress = 100
        item.downloadedSize = item.size
        item.completedAt = state.completedAt ?? Date.now()
        item.speedBytesPerSec = 0
        item.timeRemainingSec = 0
        item.fileName = state.fileName
        done = true
        break
      case 'error':
        item.status = 'failed'
        item.error = state.error
        item.speedBytesPerSec = 0
        item.timeRemainingSec = 0
        done = true
        break
      case 'cancelled':
        // cancelItem/stopActive already set the item's final status; nothing more to apply.
        done = true
        break
    }

    this.recomputeProgress(queue)
    this.persist()

    if (done) {
      const downloadId = state.id
      this.setActive(null)
      // The queue has captured everything it needs from this download — freeing the slot now,
      // rather than leaving it to linger as "the current download", lets the next item (or an
      // ad-hoc download) start right away.
      void this.downloads.remove(downloadId).finally(() => this.tick())
    }
  }
}
