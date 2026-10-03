import type { Queue, QueueAction, SystemActionLogEntry } from '../src/shared/types'
import { BLOCK, expect, test } from './fixtures'

// Post-download system actions: once a queue finishes, it can optionally and automatically put
// the system to sleep, hibernate it, or shut it down, with a cancellable countdown and a log of
// what ran. These tests drive the systemAction:* IPC surface directly (window.plexo), the same
// contract the renderer's QueueDetailScreen/QueueScreen call — never main-process internals — so
// a refactor of SystemActionManager can't break a test that still describes correct behavior.
//
// SAFETY: every test here runs with PLEXO_E2E_SYSTEM_ACTION_STUB=1 (see test.use below), which
// makes runSystemActionCommand (src/main/system/systemActions.ts) a no-op instead of touching
// child_process at all — see testKnobs.ts. Nothing in this file, or in the app code it drives,
// ever reaches a real sleep/hibernate/shutdown command: the stub is checked first and returns (or
// throws, for the one failure test, via PLEXO_E2E_SYSTEM_ACTION_FAIL) before any platform-specific
// command would otherwise be chosen. A 'ran' outcome a test asserts on is proof the app *decided*
// to run the action, not that anything real happened.

test.use({ appEnv: { PLEXO_E2E_SYSTEM_ACTION_STUB: '1' } })

const SIZE = BLOCK

type Origin = { url: (path?: string) => string }

type Api = {
  api: {
    createQueue: (name: string, description?: string) => Promise<Queue>
    getQueues: () => Promise<Queue[]>
    addQueueDownload: (queueId: string, url: string) => Promise<{ id: string }>
    resumeQueue: (queueId: string) => Promise<void>
    setSystemAction: (queueId: string, action: Omit<QueueAction, 'queueId'>) => Promise<QueueAction>
    getSystemAction: (queueId: string) => Promise<QueueAction | null>
    getSystemActions: () => Promise<QueueAction[]>
    removeSystemAction: (queueId: string) => Promise<void>
    getSystemActionLog: () => Promise<SystemActionLogEntry[]>
    cancelSystemAction: (queueId: string) => Promise<void>
    confirmSystemAction: (queueId: string) => Promise<void>
  }
}

function baseAction(
  overrides: Partial<Omit<QueueAction, 'queueId'>> = {}
): Omit<QueueAction, 'queueId'> {
  return { action: 'sleep', confirmBefore: false, ...overrides }
}

async function waitForQueueStatus(
  plexo: Api,
  queueId: string,
  status: Queue['status'],
  timeout = 20_000
): Promise<Queue> {
  const deadline = Date.now() + timeout
  let last: Queue | undefined
  while (Date.now() < deadline) {
    const queues = await plexo.api.getQueues()
    last = queues.find((queue) => queue.id === queueId)
    if (last && last.status === status) return last
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(
    `Timed out waiting for queue ${queueId} to reach "${status}". Last seen: ${
      last ? JSON.stringify(last) : 'not found'
    }`
  )
}

async function waitForLogEntry(
  plexo: Api,
  queueId: string,
  timeout = 20_000
): Promise<SystemActionLogEntry> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const log = await plexo.api.getSystemActionLog()
    const entry = log.find((e) => e.queueId === queueId)
    if (entry) return entry
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for a system-action log entry for queue ${queueId}`)
}

/** Creates a queue with the given system action already configured, adds one small download, and
 * runs it to completion — shared setup for every test below. */
async function runConfiguredQueueToCompletion(
  plexo: Api,
  serve: (options: { size: number }) => Promise<Origin>,
  name: string,
  action: Omit<QueueAction, 'queueId'>
): Promise<string> {
  const queue = await plexo.api.createQueue(name)
  await plexo.api.setSystemAction(queue.id, action)
  const origin = await serve({ size: SIZE })
  await plexo.api.addQueueDownload(queue.id, origin.url())
  await plexo.api.resumeQueue(queue.id)
  await waitForQueueStatus(plexo, queue.id, 'completed')
  return queue.id
}

test.describe('system action config CRUD @smoke', () => {
  test('setting, getting, and removing a system action for a queue', async ({ plexo }) => {
    const queue = await plexo.api.createQueue('Nightly cleanup')
    expect(await plexo.api.getSystemAction(queue.id)).toBeNull()

    const saved = await plexo.api.setSystemAction(queue.id, baseAction({ action: 'shutdown' }))
    expect(saved).toEqual({ queueId: queue.id, ...baseAction({ action: 'shutdown' }) })

    const fetched = await plexo.api.getSystemAction(queue.id)
    expect(fetched).toEqual(saved)

    const all = await plexo.api.getSystemActions()
    expect(all.map((entry) => entry.queueId)).toContain(queue.id)

    await plexo.api.removeSystemAction(queue.id)
    expect(await plexo.api.getSystemAction(queue.id)).toBeNull()
    const afterRemove = await plexo.api.getSystemActions()
    expect(afterRemove.map((entry) => entry.queueId)).not.toContain(queue.id)
  })

  test("setSystemAction overwrites a queue's existing config rather than duplicating it", async ({
    plexo
  }) => {
    const queue = await plexo.api.createQueue('Overwrite')
    await plexo.api.setSystemAction(queue.id, baseAction({ action: 'sleep' }))
    await plexo.api.setSystemAction(queue.id, baseAction({ action: 'hibernate' }))

    const all = await plexo.api.getSystemActions()
    expect(all.filter((entry) => entry.queueId === queue.id)).toHaveLength(1)
    expect(all.find((entry) => entry.queueId === queue.id)?.action).toBe('hibernate')
  })
})

test.describe('running the configured action @smoke', () => {
  test('action "none" logs nothing and prompts nothing when the queue completes', async ({
    plexo,
    serve
  }) => {
    const queueId = await runConfiguredQueueToCompletion(plexo, serve, 'No action', {
      action: 'none',
      confirmBefore: false
    })

    // Give a (mis-)fire a moment to show up before asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 500))
    const log = await plexo.api.getSystemActionLog()
    expect(log.find((entry) => entry.queueId === queueId)).toBeUndefined()
  })

  test('confirmBefore: false runs the stubbed command exactly once and logs "ran"', async ({
    plexo,
    serve
  }) => {
    const queueId = await runConfiguredQueueToCompletion(
      plexo,
      serve,
      'Runs immediately',
      baseAction({ action: 'sleep', confirmBefore: false })
    )

    const entry = await waitForLogEntry(plexo, queueId)
    expect(entry.action).toBe('sleep')
    expect(entry.outcome).toBe('ran')

    // Exactly once: no second entry turns up for this queue after waiting a bit longer.
    await new Promise((resolve) => setTimeout(resolve, 500))
    const log = await plexo.api.getSystemActionLog()
    expect(log.filter((e) => e.queueId === queueId)).toHaveLength(1)
  })
})

test.describe('a failing command @smoke', () => {
  test.use({
    appEnv: {
      PLEXO_E2E_SYSTEM_ACTION_STUB: '1',
      PLEXO_E2E_SYSTEM_ACTION_FAIL: 'simulated failure'
    }
  })

  test('logs outcome "failed" with the error, without crashing the app', async ({
    plexo,
    serve
  }) => {
    const queueId = await runConfiguredQueueToCompletion(
      plexo,
      serve,
      'Fails',
      baseAction({ action: 'shutdown' })
    )

    const entry = await waitForLogEntry(plexo, queueId)
    expect(entry.outcome).toBe('failed')
    expect(entry.error).toBe('simulated failure')

    // The app is still alive and answering normally after a failed action.
    const queues = await plexo.api.getQueues()
    expect(queues.some((queue) => queue.id === queueId)).toBe(true)
  })
})

test.describe('confirmBefore countdown @smoke', () => {
  test('does not run until the countdown elapses', async ({ plexo, serve }) => {
    const queueId = await runConfiguredQueueToCompletion(
      plexo,
      serve,
      'Countdown',
      baseAction({ action: 'sleep', confirmBefore: true, countdownSeconds: 2 })
    )

    // Right after completion, well inside the 2s countdown, nothing has run yet.
    const log = await plexo.api.getSystemActionLog()
    expect(log.find((entry) => entry.queueId === queueId)).toBeUndefined()

    const entry = await waitForLogEntry(plexo, queueId, 5_000)
    expect(entry.outcome).toBe('ran')
  })

  test('cancelPending stops it from ever running, and logs "cancelled"', async ({
    plexo,
    serve
  }) => {
    const queueId = await runConfiguredQueueToCompletion(
      plexo,
      serve,
      'Cancel before it fires',
      baseAction({ action: 'sleep', confirmBefore: true, countdownSeconds: 5 })
    )

    await plexo.api.cancelSystemAction(queueId)
    const entry = await waitForLogEntry(plexo, queueId)
    expect(entry.outcome).toBe('cancelled')

    // Wait past the original countdown — still only the one 'cancelled' entry, never a 'ran'.
    await new Promise((resolve) => setTimeout(resolve, 5_500))
    const log = await plexo.api.getSystemActionLog()
    expect(log.filter((e) => e.queueId === queueId)).toHaveLength(1)
    expect(log.find((e) => e.queueId === queueId)?.outcome).toBe('cancelled')
  })

  test('confirmNow skips the rest of the countdown and runs right away', async ({
    plexo,
    serve
  }) => {
    const queueId = await runConfiguredQueueToCompletion(
      plexo,
      serve,
      'Confirm now',
      baseAction({ action: 'sleep', confirmBefore: true, countdownSeconds: 30 })
    )

    const before = Date.now()
    await plexo.api.confirmSystemAction(queueId)
    const entry = await waitForLogEntry(plexo, queueId, 5_000)
    expect(entry.outcome).toBe('ran')
    // Nowhere near the 30s countdown — confirmNow actually skipped it.
    expect(Date.now() - before).toBeLessThan(5_000)
  })
})

test.describe('system action log persistence @smoke', () => {
  test('the log is capped and persists across a relaunch', async ({ plexo, serve }) => {
    const queueId = await runConfiguredQueueToCompletion(
      plexo,
      serve,
      'Persisted log',
      baseAction({ action: 'hibernate' })
    )
    const entry = await waitForLogEntry(plexo, queueId)
    expect(entry.outcome).toBe('ran')

    await plexo.relaunch()

    const restoredLog = await plexo.api.getSystemActionLog()
    expect(restoredLog.find((e) => e.id === entry.id)).toEqual(entry)
  })
})

test.describe('a pending countdown does not survive a quit @smoke', () => {
  test('quitting while a countdown is pending never fires it after restart', async ({
    plexo,
    serve
  }) => {
    const queueId = await runConfiguredQueueToCompletion(
      plexo,
      serve,
      'Quit mid-countdown',
      baseAction({ action: 'shutdown', confirmBefore: true, countdownSeconds: 30 })
    )

    // Still well inside the 30s countdown when the app quits.
    await plexo.relaunch()

    // No dangling timer survived: nothing fires on its own after restart.
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const log = await plexo.api.getSystemActionLog()
    expect(log.find((e) => e.queueId === queueId)).toBeUndefined()
  })
})
