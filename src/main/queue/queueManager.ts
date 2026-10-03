import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import type { DownloadUpdate, Queue, QueueItem, StartDownloadRequest } from '../../shared/types'
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
    const item: QueueItem = {
      id: randomUUID(),
      url: trimmed,
      fileName: fileNameFromUrl(trimmed),
      status: 'pending',
      progress: 0,
      size: 0,
      downloadedSize: 0,
      speedBytesPerSec: 0,
      timeRemainingSec: 0,
      addedAt: Date.now()
    }
    queue.items.push(item)
    // A queue that had finished has somewhere new to go.
    if (queue.status === 'completed') queue.status = 'idle'
    this.recomputeProgress(queue)
    this.persist()
    void this.tick()
    return structuredClone(item)
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

  private find(queueId: string): Queue | undefined {
    return this.queues.find((queue) => queue.id === queueId)
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
    this.active = null
    await this.downloads.remove(downloadId)
  }

  /** The first pending item of the first active queue, in queue and item order — queues are
   * processed FIFO, and so is each queue's own list. */
  private nextCandidate(): { queue: Queue; item: QueueItem } | undefined {
    for (const queue of this.queues) {
      if (queue.status !== 'active') continue
      const item = queue.items.find((entry) => entry.status === 'pending')
      if (item) return { queue, item }
    }
    return undefined
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
          this.active = { queueId: queue.id, itemId: item.id, downloadId }
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
      this.active = null
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
      this.active = null
      // The queue has captured everything it needs from this download — freeing the slot now,
      // rather than leaving it to linger as "the current download", lets the next item (or an
      // ad-hoc download) start right away.
      void this.downloads.remove(downloadId).finally(() => this.tick())
    }
  }
}
