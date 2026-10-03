import type { Queue, QueueBandwidthSettings, QueueBandwidthUsage } from '../src/shared/types'
import { BLOCK, expect, test } from './fixtures'

// Bandwidth: a global max download speed (applied to every transfer, ad-hoc or queue-driven), a
// per-queue speed override, and a per-queue total-traffic cap with a reset schedule. These tests
// drive the bandwidth:* IPC surface directly (window.plexo), the same contract the renderer's
// SettingsScreen/QueueDetailScreen call — never main-process internals — so a refactor of
// BandwidthManager can't break a test that still describes correct behavior. The reset schedule's
// background tick is never waited out for real: every reset test uses checkBandwidthNow() (the
// manual escape hatch), the same pattern as schedule.spec.ts's checkSchedulesNow().

const KB = 1024
const DAY = 24 * 60 * 60 * 1000

type Api = {
  api: {
    createQueue: (name: string, description?: string) => Promise<Queue>
    getQueues: () => Promise<Queue[]>
    addQueueDownload: (queueId: string, url: string) => Promise<{ id: string }>
    resumeQueue: (queueId: string) => Promise<void>
    getGlobalBandwidthLimit: () => Promise<number>
    setGlobalBandwidthLimit: (bytesPerSec: number) => Promise<void>
    getQueueBandwidthLimit: (queueId: string) => Promise<QueueBandwidthSettings | null>
    getQueueBandwidthLimits: () => Promise<QueueBandwidthSettings[]>
    setQueueBandwidthLimit: (
      queueId: string,
      patch: Omit<QueueBandwidthSettings, 'queueId'>
    ) => Promise<QueueBandwidthSettings>
    removeQueueBandwidthLimit: (queueId: string) => Promise<void>
    getBandwidthUsage: () => Promise<QueueBandwidthUsage[]>
    checkBandwidthNow: () => Promise<void>
  }
}

async function waitForQueue(
  plexo: Api,
  queueId: string,
  predicate: (queue: Queue) => boolean,
  timeout = 20_000
): Promise<Queue> {
  const deadline = Date.now() + timeout
  let last: Queue | undefined
  while (Date.now() < deadline) {
    const queues = await plexo.api.getQueues()
    last = queues.find((queue) => queue.id === queueId)
    if (last && predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(
    `Timed out waiting on queue ${queueId}. Last seen: ${last ? JSON.stringify(last) : 'not found'}`
  )
}

function itemStatus(queue: Queue, itemId: string): string | undefined {
  return queue.items.find((item) => item.id === itemId)?.status
}

test.describe('bandwidth settings CRUD @smoke', () => {
  test('global limit: get/set round-trips, 0 means unlimited', async ({ plexo }) => {
    expect(await plexo.api.getGlobalBandwidthLimit()).toBe(0)

    await plexo.api.setGlobalBandwidthLimit(256 * KB)
    expect(await plexo.api.getGlobalBandwidthLimit()).toBe(256 * KB)

    await plexo.api.setGlobalBandwidthLimit(0)
    expect(await plexo.api.getGlobalBandwidthLimit()).toBe(0)
  })

  test('per-queue limit: set/get/remove round-trips', async ({ plexo }) => {
    const queue = await plexo.api.createQueue('Bandwidth')
    expect(await plexo.api.getQueueBandwidthLimit(queue.id)).toBeNull()

    const saved = await plexo.api.setQueueBandwidthLimit(queue.id, {
      useGlobalLimit: false,
      limit: { usedBytes: 0, maxSpeedBytesPerSec: 128 * KB, maxTrafficBytes: 10 * KB * KB * KB }
    })
    expect(saved.useGlobalLimit).toBe(false)
    expect(saved.limit?.maxSpeedBytesPerSec).toBe(128 * KB)

    const fetched = await plexo.api.getQueueBandwidthLimit(queue.id)
    expect(fetched?.limit?.maxSpeedBytesPerSec).toBe(128 * KB)
    expect((await plexo.api.getQueueBandwidthLimits()).map((entry) => entry.queueId)).toContain(
      queue.id
    )

    await plexo.api.removeQueueBandwidthLimit(queue.id)
    expect(await plexo.api.getQueueBandwidthLimit(queue.id)).toBeNull()
  })

  test('usage starts at zero for a queue with no limit configured', async ({ plexo }) => {
    const queue = await plexo.api.createQueue('No limit')
    const usage = (await plexo.api.getBandwidthUsage()).find((entry) => entry.queueId === queue.id)
    expect(usage).toBeUndefined()
  })
})

test.describe('speed limiting @smoke', () => {
  test('a global speed limit well below the server measurably slows a download', async ({
    plexo,
    serve
  }) => {
    const size = 8 * BLOCK // 512 KB with the e2e's 64 KB block size
    const cap = 48 * KB // far below what the local test server can actually serve

    const fast = await serve({ size })
    const unthrottledStart = Date.now()
    const fastId = await plexo.start(fast.url(), fast.sha256, { connections: 2 })
    await plexo.waitForStatus('completed')
    const unthrottledMs = Date.now() - unthrottledStart
    await plexo.api.removeDownload(fastId)

    await plexo.api.setGlobalBandwidthLimit(cap)
    const throttled = await serve({ size })
    const throttledStart = Date.now()
    await plexo.start(throttled.url(), throttled.sha256, { connections: 2 })
    await plexo.waitForStatus('completed', 30_000)
    const throttledMs = Date.now() - throttledStart

    // The bucket starts with a full second's burst (see RateLimiter.setLimit), so the floor is a
    // little under size/cap — generous tolerance either side keeps this robust under CI load.
    const expectedMs = (size / cap) * 1000
    expect(throttledMs, 'roughly tracks size/cap').toBeGreaterThan(expectedMs * 0.5)
    expect(throttledMs, 'measurably slower than the unthrottled baseline').toBeGreaterThan(
      unthrottledMs * 3
    )
  })

  test('0 clears the global limit and downloads run unthrottled again', async ({
    plexo,
    serve
  }) => {
    await plexo.api.setGlobalBandwidthLimit(32 * KB)
    await plexo.api.setGlobalBandwidthLimit(0)

    const origin = await serve({ size: 8 * BLOCK })
    const started = Date.now()
    await plexo.start(origin.url(), origin.sha256, { connections: 2 })
    await plexo.waitForStatus('completed')
    expect(Date.now() - started, 'no cap left in effect').toBeLessThan(5000)
  })

  test('a per-queue override is honored over the global limit when useGlobalLimit is false', async ({
    plexo,
    serve
  }) => {
    // A very slow global limit that would make the queue's download take a long time if it
    // applied — the override must mean it never does.
    await plexo.api.setGlobalBandwidthLimit(16 * KB)

    const queue = await plexo.api.createQueue('Fast override')
    await plexo.api.setQueueBandwidthLimit(queue.id, { useGlobalLimit: false, limit: undefined })

    const origin = await serve({ size: 8 * BLOCK })
    const item = await plexo.api.addQueueDownload(queue.id, origin.url())
    const started = Date.now()
    await plexo.api.resumeQueue(queue.id)
    await waitForQueue(plexo, queue.id, (q) => itemStatus(q, item.id) === 'completed', 10_000)
    expect(Date.now() - started, 'ran unthrottled despite a slow global limit').toBeLessThan(5000)
  })

  test('useGlobalLimit true defers to the (slow) global limit even with no queue override set', async ({
    plexo,
    serve
  }) => {
    const size = 8 * BLOCK
    const cap = 48 * KB
    await plexo.api.setGlobalBandwidthLimit(cap)

    const queue = await plexo.api.createQueue('Deferred to global')
    await plexo.api.setQueueBandwidthLimit(queue.id, { useGlobalLimit: true, limit: undefined })

    const origin = await serve({ size })
    const item = await plexo.api.addQueueDownload(queue.id, origin.url())
    const started = Date.now()
    await plexo.api.resumeQueue(queue.id)
    await waitForQueue(plexo, queue.id, (q) => itemStatus(q, item.id) === 'completed', 30_000)
    const elapsed = Date.now() - started
    expect(elapsed, 'throttled by the global limit').toBeGreaterThan((size / cap) * 1000 * 0.5)
  })
})

test.describe('traffic cap @smoke', () => {
  test('a queue stops starting new pending items once usage crosses its cap', async ({
    plexo,
    serve
  }) => {
    const size = 4 * BLOCK
    const origin = await serve({ size })
    const queue = await plexo.api.createQueue('Capped')
    // The cap sits inside the first item's size, so it's crossed mid-transfer — the running item
    // must still be allowed to finish (see BandwidthManager's module doc).
    await plexo.api.setQueueBandwidthLimit(queue.id, {
      useGlobalLimit: true,
      limit: { usedBytes: 0, maxTrafficBytes: Math.floor(size / 2), resetSchedule: 'never' }
    })
    const item1 = await plexo.api.addQueueDownload(queue.id, origin.url('/files/first.bin'))
    const item2 = await plexo.api.addQueueDownload(queue.id, origin.url('/files/second.bin'))

    await plexo.api.resumeQueue(queue.id)
    await waitForQueue(plexo, queue.id, (q) => itemStatus(q, item1.id) === 'completed')

    // Give the (already-capped) queue every chance it would need to wrongly start item2.
    await new Promise((resolve) => setTimeout(resolve, 500))
    const queues = await plexo.api.getQueues()
    const capped = queues.find((q) => q.id === queue.id) as Queue
    expect(itemStatus(capped, item2.id)).toBe('pending')
    expect(capped.capReached).toBe(true)

    const usage = (await plexo.api.getBandwidthUsage()).find((entry) => entry.queueId === queue.id)
    expect(usage?.capReached).toBe(true)
    expect(usage?.usedBytes).toBeGreaterThanOrEqual(Math.floor(size / 2))
  })

  test('checkBandwidthNow resets usage on schedule and lets the queue resume', async ({
    plexo,
    serve
  }) => {
    const size = 4 * BLOCK
    const origin = await serve({ size })
    const queue = await plexo.api.createQueue('Reset me')
    await plexo.api.setQueueBandwidthLimit(queue.id, {
      useGlobalLimit: true,
      limit: {
        usedBytes: 0,
        maxTrafficBytes: Math.floor(size / 2),
        resetSchedule: 'daily',
        // Already due for a reset as of "now" — the deterministic escape hatch, same idea as
        // schedule.spec.ts setting startTime in the past.
        lastResetAt: Date.now() - 2 * DAY
      }
    })
    const item1 = await plexo.api.addQueueDownload(queue.id, origin.url('/files/first.bin'))
    const item2 = await plexo.api.addQueueDownload(queue.id, origin.url('/files/second.bin'))

    await plexo.api.resumeQueue(queue.id)
    await waitForQueue(plexo, queue.id, (q) => itemStatus(q, item1.id) === 'completed')
    const capped = (await plexo.api.getQueues()).find((q) => q.id === queue.id) as Queue
    expect(capped.capReached).toBe(true)

    await plexo.api.checkBandwidthNow()

    const usage = (await plexo.api.getBandwidthUsage()).find((entry) => entry.queueId === queue.id)
    expect(usage?.usedBytes).toBe(0)
    await waitForQueue(plexo, queue.id, (q) => itemStatus(q, item2.id) === 'completed', 10_000)
    const resumed = (await plexo.api.getQueues()).find((q) => q.id === queue.id) as Queue
    expect(resumed.capReached).toBe(false)
  })

  test('checkBandwidthNow is a no-op before a reset is due', async ({ plexo, serve }) => {
    const size = 4 * BLOCK
    const origin = await serve({ size })
    const queue = await plexo.api.createQueue('Not due yet')
    await plexo.api.setQueueBandwidthLimit(queue.id, {
      useGlobalLimit: true,
      limit: {
        usedBytes: 0,
        maxTrafficBytes: Math.floor(size / 2),
        resetSchedule: 'daily',
        lastResetAt: Date.now() // just reset, not due again for ~a day
      }
    })
    const item1 = await plexo.api.addQueueDownload(queue.id, origin.url())
    await plexo.api.resumeQueue(queue.id)
    await waitForQueue(plexo, queue.id, (q) => itemStatus(q, item1.id) === 'completed')

    await plexo.api.checkBandwidthNow()
    const usage = (await plexo.api.getBandwidthUsage()).find((entry) => entry.queueId === queue.id)
    expect(usage?.usedBytes).toBeGreaterThan(0)
    expect(usage?.capReached).toBe(true)
  })
})

test.describe('bandwidth persistence @smoke', () => {
  test('usage and limits survive a relaunch', async ({ plexo, serve }) => {
    const size = 4 * BLOCK
    const origin = await serve({ size })
    await plexo.api.setGlobalBandwidthLimit(777 * KB)
    const queue = await plexo.api.createQueue('Persisted bandwidth')
    await plexo.api.setQueueBandwidthLimit(queue.id, {
      useGlobalLimit: false,
      limit: { usedBytes: 0, maxSpeedBytesPerSec: 500 * KB, maxTrafficBytes: size * 10 }
    })
    const item = await plexo.api.addQueueDownload(queue.id, origin.url())
    await plexo.api.resumeQueue(queue.id)
    await waitForQueue(plexo, queue.id, (q) => itemStatus(q, item.id) === 'completed')

    const usageBefore = (await plexo.api.getBandwidthUsage()).find(
      (entry) => entry.queueId === queue.id
    )
    expect(usageBefore?.usedBytes).toBeGreaterThanOrEqual(size)

    await plexo.relaunch()

    expect(await plexo.api.getGlobalBandwidthLimit()).toBe(777 * KB)
    const limitAfter = await plexo.api.getQueueBandwidthLimit(queue.id)
    expect(limitAfter?.limit?.maxSpeedBytesPerSec).toBe(500 * KB)
    const usageAfter = (await plexo.api.getBandwidthUsage()).find(
      (entry) => entry.queueId === queue.id
    )
    expect(usageAfter?.usedBytes).toBe(usageBefore?.usedBytes)
  })
})
