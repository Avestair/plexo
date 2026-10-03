import type { Queue, QueueSchedule } from '../src/shared/types'
import { expect, test } from './fixtures'

// Scheduling: a queue can be told to start automatically at a given time, and optionally pause
// again later, with optional daily/weekly repetition. These tests drive the schedule:* IPC
// surface directly (window.plexo), the same contract the renderer's Schedule screen calls — never
// main-process internals — so a refactor of ScheduleManager can't break a test that still
// describes correct behavior. The 60s background tick is never waited out for real: every test
// uses checkSchedulesNow() (the manual escape hatch) for a deterministic, instant check.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

type Api = {
  api: {
    createQueue: (name: string, description?: string) => Promise<Queue>
    getQueues: () => Promise<Queue[]>
    resumeQueue: (queueId: string) => Promise<void>
    pauseQueue: (queueId: string) => Promise<void>
    setSchedule: (
      queueId: string,
      schedule: Omit<QueueSchedule, 'queueId'>
    ) => Promise<QueueSchedule>
    getSchedule: (queueId: string) => Promise<QueueSchedule | null>
    getSchedules: () => Promise<QueueSchedule[]>
    removeSchedule: (queueId: string) => Promise<void>
    checkSchedulesNow: () => Promise<void>
  }
}

async function queueStatus(plexo: Api, queueId: string): Promise<string | undefined> {
  const queues = await plexo.api.getQueues()
  return queues.find((queue) => queue.id === queueId)?.status
}

function baseSchedule(
  overrides: Partial<Omit<QueueSchedule, 'queueId'>> = {}
): Omit<QueueSchedule, 'queueId'> {
  return {
    startTime: null,
    sleepTime: null,
    repeatDaily: false,
    enabled: true,
    ...overrides
  }
}

/** Mirrors ScheduleManager's own weekly-rollover math (see scheduleManager.ts's
 * nextWeeklyOccurrence) so a test can predict the exact value it should produce, including across
 * a DST boundary, without depending on its internals. */
function expectedNextWeeklyOccurrence(
  time: number,
  weekly: NonNullable<QueueSchedule['repeatWeekly']>
): number {
  const order: (keyof NonNullable<QueueSchedule['repeatWeekly']>)[] = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday'
  ]
  const base = new Date(time)
  for (let offset = 1; offset <= 7; offset++) {
    const candidate = new Date(base)
    candidate.setDate(candidate.getDate() + offset)
    if (weekly[order[candidate.getDay()]]) return candidate.getTime()
  }
  return time
}

test.describe('schedule CRUD @smoke', () => {
  test('setting, getting, and removing a schedule for a queue', async ({ plexo }) => {
    const queue = await plexo.api.createQueue('Nightly')
    expect(await plexo.api.getSchedule(queue.id)).toBeNull()

    const startTime = Date.now() + HOUR
    const saved = await plexo.api.setSchedule(queue.id, baseSchedule({ startTime }))
    expect(saved).toEqual({ queueId: queue.id, ...baseSchedule({ startTime }) })

    const fetched = await plexo.api.getSchedule(queue.id)
    expect(fetched).toEqual(saved)

    const all = await plexo.api.getSchedules()
    expect(all.map((schedule) => schedule.queueId)).toContain(queue.id)

    await plexo.api.removeSchedule(queue.id)
    expect(await plexo.api.getSchedule(queue.id)).toBeNull()
    const afterRemove = await plexo.api.getSchedules()
    expect(afterRemove.map((schedule) => schedule.queueId)).not.toContain(queue.id)
  })

  test("setSchedule overwrites a queue's existing schedule rather than duplicating it", async ({
    plexo
  }) => {
    const queue = await plexo.api.createQueue('Overwrite')
    await plexo.api.setSchedule(queue.id, baseSchedule({ startTime: Date.now() + HOUR }))
    await plexo.api.setSchedule(queue.id, baseSchedule({ startTime: Date.now() + 2 * HOUR }))

    const all = await plexo.api.getSchedules()
    expect(all.filter((schedule) => schedule.queueId === queue.id)).toHaveLength(1)
  })
})

test.describe('checkSchedulesNow start/pause @smoke', () => {
  test('starts an enabled queue whose startTime has passed', async ({ plexo }) => {
    const queue = await plexo.api.createQueue('Due')
    expect(await queueStatus(plexo, queue.id)).toBe('idle')

    await plexo.api.setSchedule(queue.id, baseSchedule({ startTime: Date.now() - MINUTE }))
    await plexo.api.checkSchedulesNow()

    expect(await queueStatus(plexo, queue.id)).toBe('active')
  })

  test('does not start a queue whose startTime is still in the future', async ({ plexo }) => {
    const queue = await plexo.api.createQueue('Future')
    await plexo.api.setSchedule(queue.id, baseSchedule({ startTime: Date.now() + HOUR }))
    await plexo.api.checkSchedulesNow()

    expect(await queueStatus(plexo, queue.id)).toBe('idle')
  })

  test('does not start a queue whose schedule is disabled', async ({ plexo }) => {
    const queue = await plexo.api.createQueue('Disabled')
    await plexo.api.setSchedule(
      queue.id,
      baseSchedule({ startTime: Date.now() - MINUTE, enabled: false })
    )
    await plexo.api.checkSchedulesNow()

    expect(await queueStatus(plexo, queue.id)).toBe('idle')
  })

  test('a queue already active is left alone, and its schedule is not treated as fired', async ({
    plexo
  }) => {
    const queue = await plexo.api.createQueue('Already running')
    await plexo.api.resumeQueue(queue.id)
    expect(await queueStatus(plexo, queue.id)).toBe('active')

    const startTime = Date.now() - MINUTE
    await plexo.api.setSchedule(queue.id, baseSchedule({ startTime }))
    await plexo.api.checkSchedulesNow()

    expect(await queueStatus(plexo, queue.id)).toBe('active')
    // Not treated as "fired": a one-shot schedule that actually acted would have disabled itself
    // (see the one-shot test below) — this one is still enabled with its startTime untouched.
    const schedule = await plexo.api.getSchedule(queue.id)
    expect(schedule?.enabled).toBe(true)
    expect(schedule?.startTime).toBe(startTime)
  })

  test('pauses an active queue once sleepTime has passed', async ({ plexo }) => {
    const queue = await plexo.api.createQueue('Sleepy')
    await plexo.api.resumeQueue(queue.id)
    expect(await queueStatus(plexo, queue.id)).toBe('active')

    await plexo.api.setSchedule(
      queue.id,
      baseSchedule({ startTime: null, sleepTime: Date.now() - MINUTE })
    )
    await plexo.api.checkSchedulesNow()

    expect(await queueStatus(plexo, queue.id)).toBe('paused')
  })

  test('does not pause a queue whose sleepTime is still in the future', async ({ plexo }) => {
    const queue = await plexo.api.createQueue('Not yet sleepy')
    await plexo.api.resumeQueue(queue.id)

    await plexo.api.setSchedule(
      queue.id,
      baseSchedule({ startTime: null, sleepTime: Date.now() + HOUR })
    )
    await plexo.api.checkSchedulesNow()

    expect(await queueStatus(plexo, queue.id)).toBe('active')
  })
})

test.describe('schedule repetition @smoke', () => {
  test('a one-shot schedule disables itself after firing its last pending action', async ({
    plexo
  }) => {
    const queue = await plexo.api.createQueue('One shot')
    const startTime = Date.now() - MINUTE
    await plexo.api.setSchedule(queue.id, baseSchedule({ startTime }))
    await plexo.api.checkSchedulesNow()

    expect(await queueStatus(plexo, queue.id)).toBe('active')
    const schedule = await plexo.api.getSchedule(queue.id)
    expect(schedule?.enabled).toBe(false)
    // Disabled, not deleted — and not re-timed, so the user can see/edit what it was set to.
    expect(schedule?.startTime).toBe(startTime)
  })

  test('a one-shot schedule with a sleepTime only disables itself once the sleep fires', async ({
    plexo
  }) => {
    const queue = await plexo.api.createQueue('One shot with sleep')
    const startTime = Date.now() - 2 * MINUTE
    const sleepTime = Date.now() + HOUR // not due yet
    await plexo.api.setSchedule(queue.id, baseSchedule({ startTime, sleepTime }))
    await plexo.api.checkSchedulesNow()

    // The start fired, but the schedule still has a pending action (the sleep), so it must stay
    // enabled.
    expect(await queueStatus(plexo, queue.id)).toBe('active')
    let schedule = await plexo.api.getSchedule(queue.id)
    expect(schedule?.enabled).toBe(true)

    // Now the sleep is due too.
    await plexo.api.setSchedule(
      queue.id,
      baseSchedule({ startTime, sleepTime: Date.now() - MINUTE })
    )
    await plexo.api.checkSchedulesNow()

    expect(await queueStatus(plexo, queue.id)).toBe('paused')
    schedule = await plexo.api.getSchedule(queue.id)
    expect(schedule?.enabled).toBe(false)
  })

  test('a daily repeat rolls startTime (and sleepTime) forward by exactly 24h', async ({
    plexo
  }) => {
    const queue = await plexo.api.createQueue('Daily')
    const startTime = Date.now() - MINUTE
    const sleepTime = Date.now() - 30_000
    await plexo.api.setSchedule(queue.id, baseSchedule({ startTime, sleepTime, repeatDaily: true }))
    // Queue starts idle: start fires this tick, which also makes the queue active so the
    // already-due sleepTime fires in the very same tick, completing the occurrence.
    await plexo.api.checkSchedulesNow()

    const schedule = await plexo.api.getSchedule(queue.id)
    expect(schedule?.enabled).toBe(true)
    expect(schedule?.startTime).toBe(startTime + DAY)
    expect(schedule?.sleepTime).toBe(sleepTime + DAY)
  })

  test('a weekly repeat rolls startTime forward to the next enabled weekday, same time of day', async ({
    plexo
  }) => {
    const queue = await plexo.api.createQueue('Weekly')
    const startTime = Date.now() - MINUTE
    const tomorrow = new Date(startTime)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const order: (keyof NonNullable<QueueSchedule['repeatWeekly']>)[] = [
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday'
    ]
    const tomorrowKey = order[tomorrow.getDay()]
    const repeatWeekly: NonNullable<QueueSchedule['repeatWeekly']> = {
      monday: false,
      tuesday: false,
      wednesday: false,
      thursday: false,
      friday: false,
      saturday: false,
      sunday: false,
      [tomorrowKey]: true
    }

    await plexo.api.setSchedule(queue.id, baseSchedule({ startTime, repeatWeekly }))
    await plexo.api.checkSchedulesNow()

    const schedule = await plexo.api.getSchedule(queue.id)
    expect(schedule?.enabled).toBe(true)
    expect(schedule?.startTime).toBe(expectedNextWeeklyOccurrence(startTime, repeatWeekly))
    expect(schedule?.startTime).toBe(tomorrow.getTime())
  })
})

test.describe('schedule persistence @smoke', () => {
  test('a schedule survives a relaunch', async ({ plexo }) => {
    const queue = await plexo.api.createQueue('Persisted schedule')
    const schedule = baseSchedule({
      startTime: Date.now() + HOUR,
      sleepTime: Date.now() + 2 * HOUR,
      repeatDaily: true
    })
    await plexo.api.setSchedule(queue.id, schedule)

    await plexo.relaunch()

    const restored = await plexo.api.getSchedule(queue.id)
    expect(restored).toEqual({ queueId: queue.id, ...schedule })
  })
})
