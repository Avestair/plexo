import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/** Subscribes once to main-process schedule pushes for the lifetime of the app — mirrors
 * useQueues. Screens read the result from useAppStore and call the window.plexo schedule methods
 * directly, the same way the queue screens do. */
export function useSchedules(): void {
  const receiveSchedulesUpdate = useAppStore((store) => store.receiveSchedulesUpdate)

  useEffect(() => {
    let disposed = false
    // Subscribed before the snapshot is asked for, so nothing sent in between is missed.
    const unsubscribe = window.plexo.onSchedulesUpdated(receiveSchedulesUpdate)

    void window.plexo
      .getSchedules()
      .then((schedules) => {
        if (!disposed) receiveSchedulesUpdate(schedules)
      })
      .catch(() => {})

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [receiveSchedulesUpdate])
}
