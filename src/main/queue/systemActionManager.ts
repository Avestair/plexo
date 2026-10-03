import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import type {
  PendingSystemAction,
  Queue,
  QueueAction,
  SystemActionLogEntry,
  SystemActionState
} from '../../shared/types'
import {
  flushSystemActionData,
  loadSystemActionData,
  scheduleSaveSystemActionData,
  SYSTEM_ACTION_LOG_CAP,
  type SystemActionData
} from '../storage/systemActionStorage'
import { runSystemActionCommand } from '../system/systemActions'
import type { QueueManager } from './queueManager'

/** Used when a confirmable action doesn't say how long to count down. */
const DEFAULT_COUNTDOWN_SECONDS = 30

interface PendingEntry {
  queueId: string
  queueName: string
  action: QueueAction['action']
  fireAt: number
  timer: NodeJS.Timeout
}

/**
 * Lets a queue, once it finishes, optionally and automatically put the system to sleep,
 * hibernate it, or shut it down — with a cancellable countdown and a log of what ran. One
 * QueueAction config per queue, keyed by queueId, the same shape as ScheduleManager's per-queue
 * map. Actually running the OS command is left entirely to systemActions.ts
 * (runSystemActionCommand) — this only ever decides *whether* and *when* to call it, driven by
 * QueueManager.onQueueCompleted rather than polling anything.
 */
export class SystemActionManager {
  private actions: QueueAction[] = []
  private log: SystemActionLogEntry[] = []
  private readonly pending = new Map<string, PendingEntry>()
  private readonly initialization: Promise<void>
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(
    private getWindow: () => BrowserWindow | null,
    private queues: QueueManager
  ) {
    this.initialization = this.restore()
    this.unsubscribe = this.queues.onQueueCompleted((queue) => this.handleQueueCompleted(queue))
  }

  private async restore(): Promise<void> {
    const data = await loadSystemActionData()
    this.actions = data.actions
    this.log = data.log
  }

  async getActions(): Promise<QueueAction[]> {
    await this.initialization
    return structuredClone(this.actions)
  }

  async getAction(queueId: string): Promise<QueueAction | null> {
    await this.initialization
    const action = this.find(queueId)
    return action ? structuredClone(action) : null
  }

  async setAction(queueId: string, patch: Omit<QueueAction, 'queueId'>): Promise<QueueAction> {
    await this.initialization
    const action: QueueAction = { ...patch, queueId }
    const index = this.actions.findIndex((entry) => entry.queueId === queueId)
    if (index === -1) this.actions.push(action)
    else this.actions[index] = action
    this.persist()
    return structuredClone(action)
  }

  async removeAction(queueId: string): Promise<void> {
    await this.initialization
    this.actions = this.actions.filter((entry) => entry.queueId !== queueId)
    this.persist()
  }

  async getLog(): Promise<SystemActionLogEntry[]> {
    await this.initialization
    return structuredClone(this.log)
  }

  /** Stops a countdown in progress without ever running its action, and logs that. A no-op if
   * nothing is pending for this queue (already fired, already cancelled, or never confirmable). */
  async cancelPending(queueId: string): Promise<void> {
    await this.initialization
    const entry = this.pending.get(queueId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(queueId)
    this.appendLog({
      id: randomUUID(),
      queueId: entry.queueId,
      queueName: entry.queueName,
      action: entry.action,
      at: Date.now(),
      outcome: 'cancelled'
    })
    this.persist()
  }

  /** Skips the rest of a pending countdown and runs its action right away. A no-op if nothing is
   * pending for this queue. */
  async confirmNow(queueId: string): Promise<void> {
    await this.initialization
    const entry = this.pending.get(queueId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(queueId)
    await this.execute(entry.queueId, entry.queueName, entry.action)
  }

  /** Flushes any pending debounced save immediately — for app shutdown. */
  async flush(): Promise<void> {
    await this.initialization
    await flushSystemActionData(this.snapshotData())
  }

  /** Stops watching QueueManager and clears every countdown timer without running anything — for
   * app shutdown, so a pending action can never fire moments after the user quit, and nothing
   * keeps the process alive. A countdown that was pending simply never happened; the next launch
   * starts with no pending state at all, since pending timers are never persisted. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    for (const entry of this.pending.values()) clearTimeout(entry.timer)
    this.pending.clear()
  }

  private find(queueId: string): QueueAction | undefined {
    return this.actions.find((entry) => entry.queueId === queueId)
  }

  private handleQueueCompleted(queue: Queue): void {
    // Fires synchronously off QueueManager's own listener set — but this.actions may not have
    // finished loading yet (a queue could in principle complete right at startup), so the actual
    // decision is deferred until restore() has settled, the same way every other public method
    // here awaits this.initialization before touching this.actions.
    void this.initialization.then(() => {
      if (this.disposed) return
      this.handleQueueCompletedNow(queue)
    })
  }

  private handleQueueCompletedNow(queue: Queue): void {
    const config = this.find(queue.id)
    if (!config || config.action === 'none') return

    if (!config.confirmBefore) {
      void this.execute(queue.id, queue.name, config.action)
      return
    }

    const countdownSeconds =
      config.countdownSeconds && config.countdownSeconds > 0
        ? config.countdownSeconds
        : DEFAULT_COUNTDOWN_SECONDS
    const fireAt = Date.now() + countdownSeconds * 1000
    const timer = setTimeout(() => {
      this.pending.delete(queue.id)
      void this.execute(queue.id, queue.name, config.action)
    }, countdownSeconds * 1000)
    this.pending.set(queue.id, {
      queueId: queue.id,
      queueName: queue.name,
      action: config.action,
      fireAt,
      timer
    })
    this.emit()
  }

  private async execute(
    queueId: string,
    queueName: string,
    action: QueueAction['action']
  ): Promise<void> {
    try {
      await runSystemActionCommand(action)
      this.appendLog({
        id: randomUUID(),
        queueId,
        queueName,
        action,
        at: Date.now(),
        outcome: 'ran'
      })
    } catch (error) {
      this.appendLog({
        id: randomUUID(),
        queueId,
        queueName,
        action,
        at: Date.now(),
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error)
      })
    }
    this.persist()
  }

  private appendLog(entry: SystemActionLogEntry): void {
    this.log.push(entry)
    if (this.log.length > SYSTEM_ACTION_LOG_CAP) {
      this.log = this.log.slice(-SYSTEM_ACTION_LOG_CAP)
    }
  }

  private snapshotData(): SystemActionData {
    return { actions: structuredClone(this.actions), log: structuredClone(this.log) }
  }

  private snapshotPending(): PendingSystemAction[] {
    return Array.from(this.pending.values()).map(({ queueId, queueName, action, fireAt }) => ({
      queueId,
      queueName,
      action,
      fireAt
    }))
  }

  private persist(): void {
    scheduleSaveSystemActionData(this.snapshotData())
    this.emit()
  }

  private emit(): void {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return
    const state: SystemActionState = {
      actions: structuredClone(this.actions),
      log: structuredClone(this.log),
      pending: this.snapshotPending()
    }
    window.webContents.send(IpcChannels.systemActionUpdated, state)
  }
}
