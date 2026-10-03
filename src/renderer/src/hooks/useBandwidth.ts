import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/** Subscribes once to main-process bandwidth-usage pushes for the lifetime of the app — mirrors
 * useQueues/useSchedules. Screens read the result from useAppStore and call the window.plexo
 * bandwidth methods directly, the same way the queue screens do. */
export function useBandwidth(): void {
  const receiveBandwidthUsage = useAppStore((store) => store.receiveBandwidthUsage)

  useEffect(() => {
    let disposed = false
    // Subscribed before the snapshot is asked for, so nothing sent in between is missed.
    const unsubscribe = window.plexo.onBandwidthUpdated(receiveBandwidthUsage)

    void window.plexo
      .getBandwidthUsage()
      .then((usage) => {
        if (!disposed) receiveBandwidthUsage(usage)
      })
      .catch(() => {})

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [receiveBandwidthUsage])
}
