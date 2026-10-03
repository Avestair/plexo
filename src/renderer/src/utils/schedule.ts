import type { QueueSchedule, QueueStatus } from '@shared/types'

export interface NextScheduleAction {
  kind: 'start' | 'pause'
  time: number
}

/** What a schedule will do next, for display only — the actual firing logic (and its exact
 * ordering between start/sleep in the same tick) lives in main/queue/scheduleManager.ts. This is
 * a client-side approximation good enough for a "starts in …"/"pauses in …" readout, recomputed
 * from the schedule's own stored times rather than round-tripping to the main process. */
export function nextScheduleAction(
  schedule: QueueSchedule | undefined,
  queueStatus: QueueStatus | undefined
): NextScheduleAction | null {
  if (!schedule || !schedule.enabled) return null
  if (schedule.startTime !== null && queueStatus !== 'active') {
    return { kind: 'start', time: schedule.startTime }
  }
  if (schedule.sleepTime != null && queueStatus === 'active') {
    return { kind: 'pause', time: schedule.sleepTime }
  }
  return null
}
