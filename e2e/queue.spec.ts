import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Queue, QueueItem } from '../src/shared/types'
import { BLOCK, expect, test } from './fixtures'

// Queue system: named lists of downloads run one after another through the same DownloadManager
// an ad-hoc download uses. These tests drive the queue:* IPC surface directly (window.plexo),
// the same contract the renderer's Queue screens call — never main-process internals — so a
// refactor of QueueManager can't break a test that still describes correct behavior.

const SIZE = 4 * BLOCK

async function waitForQueue(
  plexo: { api: { getQueues: () => Promise<Queue[]> } },
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

test.describe('queue CRUD @smoke', () => {
  test('create, rename, and delete a queue', async ({ plexo }) => {
    const queue = await plexo.api.createQueue('Movies', 'Weekend watchlist')
    expect(queue.name).toBe('Movies')
    expect(queue.description).toBe('Weekend watchlist')
    expect(queue.status).toBe('idle')
    expect(queue.items).toEqual([])

    let queues = await plexo.api.getQueues()
    expect(queues.map((q) => q.id)).toContain(queue.id)

    await plexo.api.updateQueueName(queue.id, '  Renamed  ')
    queues = await plexo.api.getQueues()
    expect(queues.find((q) => q.id === queue.id)?.name).toBe('Renamed')

    await plexo.api.deleteQueue(queue.id)
    queues = await plexo.api.getQueues()
    expect(queues.map((q) => q.id)).not.toContain(queue.id)
  })

  test('blank name falls back to "Untitled queue", blank rename is ignored', async ({ plexo }) => {
    const queue = await plexo.api.createQueue('   ')
    expect(queue.name).toBe('Untitled queue')
    expect(queue.description).toBeUndefined()

    await plexo.api.updateQueueName(queue.id, '   ')
    const queues = await plexo.api.getQueues()
    expect(queues.find((q) => q.id === queue.id)?.name).toBe('Untitled queue')
  })

  test('adding a download derives a file name from the URL and queues it pending', async ({
    plexo
  }) => {
    const queue = await plexo.api.createQueue('Software')
    const item = await plexo.api.addQueueDownload(queue.id, 'https://example.com/path/app.zip')
    expect(item.fileName).toBe('app.zip')
    expect(item.status).toBe('pending')
    expect(item.progress).toBe(0)

    const queues = await plexo.api.getQueues()
    const stored = queues.find((q) => q.id === queue.id)
    expect(stored?.items.map((i) => i.id)).toEqual([item.id])
  })

  test('a blank URL is rejected and never added', async ({ plexo }) => {
    const queue = await plexo.api.createQueue('Bad input')
    await expect(plexo.api.addQueueDownload(queue.id, '   ')).rejects.toThrow()
    const queues = await plexo.api.getQueues()
    expect(queues.find((q) => q.id === queue.id)?.items).toEqual([])
  })

  test('operating on an unknown queue or item is a no-op, not a crash', async ({ plexo }) => {
    await plexo.api.pauseQueue('nope')
    await plexo.api.resumeQueue('nope')
    await plexo.api.removeQueueDownload('nope', 'nope')
    await plexo.api.updateQueueName('nope', 'x')
    await plexo.api.pauseQueueItem('nope', 'nope')
    await plexo.api.resumeQueueItem('nope', 'nope')
    await plexo.api.cancelQueueItem('nope', 'nope')
    await plexo.api.reorderQueueItems('nope', [])
    // Reaching here without throwing is the assertion; getQueues still answers normally after.
    expect(await plexo.api.getQueues()).toEqual([])
  })

  test('reordering moves items, and leaves out-of-band ids in place', async ({ plexo }) => {
    const queue = await plexo.api.createQueue('Order')
    const a = await plexo.api.addQueueDownload(queue.id, 'https://example.com/a.bin')
    const b = await plexo.api.addQueueDownload(queue.id, 'https://example.com/b.bin')
    const c = await plexo.api.addQueueDownload(queue.id, 'https://example.com/c.bin')

    await plexo.api.reorderQueueItems(queue.id, [c.id, a.id, b.id])
    let queues = await plexo.api.getQueues()
    expect(queues.find((q) => q.id === queue.id)?.items.map((i) => i.id)).toEqual([
      c.id,
      a.id,
      b.id
    ])

    // An id the caller forgot keeps its place instead of vanishing.
    await plexo.api.reorderQueueItems(queue.id, [a.id])
    queues = await plexo.api.getQueues()
    expect(queues.find((q) => q.id === queue.id)?.items.map((i) => i.id)).toEqual([
      a.id,
      c.id,
      b.id
    ])
  })

  test('removing a pending item drops it without touching the rest', async ({ plexo }) => {
    const queue = await plexo.api.createQueue('Remove')
    const a = await plexo.api.addQueueDownload(queue.id, 'https://example.com/a.bin')
    const b = await plexo.api.addQueueDownload(queue.id, 'https://example.com/b.bin')
    await plexo.api.removeQueueDownload(queue.id, a.id)
    const queues = await plexo.api.getQueues()
    expect(queues.find((q) => q.id === queue.id)?.items.map((i) => i.id)).toEqual([b.id])
  })
})

test.describe('running a queue @smoke', () => {
  test('a queue downloads its item end to end, byte for byte', async ({ plexo, serve }) => {
    const origin = await serve({ size: SIZE })
    const queue = await plexo.api.createQueue('Run')
    const item = await plexo.api.addQueueDownload(queue.id, origin.url())

    await plexo.api.resumeQueue(queue.id)
    const finished = await waitForQueue(
      plexo,
      queue.id,
      (q) => itemStatus(q, item.id) === 'completed'
    )
    const completedItem = finished.items.find((i) => i.id === item.id) as QueueItem
    expect(completedItem.progress).toBe(100)
    expect(finished.status).toBe('completed')
    expect(finished.totalProgress).toBe(100)

    const bytes = await readFile(join(plexo.dirs.dest, completedItem.fileName))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(origin.sha256)
  })

  test('two queues run one item at a time, FIFO across queues and within each', async ({
    plexo,
    serve
  }) => {
    const first = await serve({ size: SIZE })
    const second = await serve({ size: SIZE })
    // Holds a1's transfer open so the "only a1 is running" assertion below can't race past it.
    const reached = first.hold(BLOCK + 10)
    const queueA = await plexo.api.createQueue('A')
    const queueB = await plexo.api.createQueue('B')
    const a1 = await plexo.api.addQueueDownload(queueA.id, first.url('/files/a1.bin'))
    const a2 = await plexo.api.addQueueDownload(queueA.id, first.url('/files/a2.bin'))
    const b1 = await plexo.api.addQueueDownload(queueB.id, second.url('/files/b1.bin'))

    await plexo.api.resumeQueue(queueA.id)
    await plexo.api.resumeQueue(queueB.id)
    await reached

    // a1 is queue A's first item: it should be the one running, with a2 and b1 still waiting.
    const midA = (await plexo.api.getQueues()).find((q) => q.id === queueA.id) as Queue
    const midB = (await plexo.api.getQueues()).find((q) => q.id === queueB.id) as Queue
    expect(itemStatus(midA, a1.id)).toBe('downloading')
    expect(itemStatus(midA, a2.id)).toBe('pending')
    expect(itemStatus(midB, b1.id)).toBe('pending')

    first.release()
    await waitForQueue(plexo, queueA.id, (q) => itemStatus(q, a1.id) === 'completed')
    await waitForQueue(plexo, queueA.id, (q) => itemStatus(q, a2.id) === 'completed', 30_000)
    await waitForQueue(plexo, queueB.id, (q) => itemStatus(q, b1.id) === 'completed', 30_000)
  })

  test('pausing a queue pauses its running item, and resume picks it back up', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: SIZE })
    const reached = origin.hold(BLOCK + 10)
    const queue = await plexo.api.createQueue('Pausable')
    const item = await plexo.api.addQueueDownload(queue.id, origin.url())
    await plexo.api.resumeQueue(queue.id)
    await reached

    await plexo.api.pauseQueue(queue.id)
    const paused = await waitForQueue(plexo, queue.id, (q) => q.status === 'paused')
    expect(itemStatus(paused, item.id)).toBe('paused')

    origin.release()
    await plexo.api.resumeQueue(queue.id)
    await waitForQueue(plexo, queue.id, (q) => itemStatus(q, item.id) === 'completed')
  })

  test('cancelling the running item frees the slot for the next one', async ({ plexo, serve }) => {
    const origin = await serve({ size: SIZE })
    const reached = origin.hold(BLOCK + 10)
    const queue = await plexo.api.createQueue('Cancel')
    const item1 = await plexo.api.addQueueDownload(queue.id, origin.url())
    const item2 = await plexo.api.addQueueDownload(queue.id, origin.url('/files/second.bin'))
    await plexo.api.resumeQueue(queue.id)
    await reached

    await plexo.api.cancelQueueItem(queue.id, item1.id)
    const afterCancel = await waitForQueue(
      plexo,
      queue.id,
      (q) => itemStatus(q, item1.id) === 'failed'
    )
    expect(afterCancel.items.find((i) => i.id === item1.id)?.error).toBe('Cancelled')

    origin.release()
    await waitForQueue(plexo, queue.id, (q) => itemStatus(q, item2.id) === 'completed')
  })

  test('deleting a queue stops its running download', async ({ plexo, serve }) => {
    const origin = await serve({ size: SIZE })
    const reached = origin.hold(BLOCK + 10)
    const queue = await plexo.api.createQueue('Doomed')
    await plexo.api.addQueueDownload(queue.id, origin.url())
    await plexo.api.resumeQueue(queue.id)
    await reached

    await plexo.api.deleteQueue(queue.id)
    const queues = await plexo.api.getQueues()
    expect(queues.map((q) => q.id)).not.toContain(queue.id)
    origin.release()
    // Nothing left running: no current (ad-hoc) download either, and the server never completes
    // the response into the app's hands past this point.
    expect(await plexo.api.getCurrentDownload()).toBeNull()
  })

  test('a queue download and an ad-hoc download contend for the same slot', async ({
    plexo,
    serve
  }) => {
    const adhoc = await serve({ size: SIZE })
    const queued = await serve({ size: SIZE })
    const reached = adhoc.hold(BLOCK + 10)
    const id = await plexo.start(adhoc.url(), adhoc.sha256, { connections: 2 })
    await reached

    const queue = await plexo.api.createQueue('Waits behind ad-hoc')
    const item = await plexo.api.addQueueDownload(queue.id, queued.url())
    await plexo.api.resumeQueue(queue.id)

    // The ad-hoc download still has the only slot; the queue item stays pending behind it.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const queues = await plexo.api.getQueues()
    expect(itemStatus(queues.find((q) => q.id === queue.id) as Queue, item.id)).toBe('pending')

    adhoc.release()
    await plexo.waitForStatus('completed')
    await plexo.api.removeDownload(id)

    await waitForQueue(plexo, queue.id, (q) => itemStatus(q, item.id) === 'completed')
  })
})

test.describe('queue persistence @smoke', () => {
  test('a normal quit suspends the running item, which survives as paused', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: SIZE })
    const reached = origin.hold(BLOCK + 10)
    const queue = await plexo.api.createQueue('Persisted')
    const running = await plexo.api.addQueueDownload(queue.id, origin.url())
    const pending = await plexo.api.addQueueDownload(queue.id, origin.url('/files/later.bin'))
    await plexo.api.resumeQueue(queue.id)
    await reached

    // A clean quit runs before-quit, which pauses (and persists) whatever is running — same as
    // it does for an ad-hoc download — so the queue item comes back paused, not downloading.
    await plexo.relaunch()

    const queues = await plexo.api.getQueues()
    const restored = queues.find((q) => q.id === queue.id)
    expect(restored?.name).toBe('Persisted')
    expect(itemStatus(restored as Queue, running.id)).toBe('paused')
    expect(itemStatus(restored as Queue, pending.id)).toBe('pending')
  })

  test('a hard kill leaves the item reset to pending on the next launch', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: SIZE })
    const reached = origin.hold(BLOCK + 10)
    const queue = await plexo.api.createQueue('Crashed')
    const item = await plexo.api.addQueueDownload(queue.id, origin.url())
    await plexo.api.resumeQueue(queue.id)
    await reached
    // The autosave debounces on every progress tick while downloading, bounded by its own
    // max-wait (5s) — wait that out so the kill below isolates the restart's own
    // downloading→pending reset rather than racing the autosave itself.
    await new Promise((resolve) => setTimeout(resolve, 5_500))

    // No before-quit this time: the process dies mid-transfer with nothing suspended.
    await plexo.kill()
    await plexo.launch()

    const queues = await plexo.api.getQueues()
    const restored = queues.find((q) => q.id === queue.id)
    expect(itemStatus(restored as Queue, item.id)).toBe('pending')
  })
})
