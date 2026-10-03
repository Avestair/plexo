import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/** Subscribes once to main-process system-action pushes for the lifetime of the app — mirrors
 * useSchedules/useQueues. Screens read the result from useAppStore and call the window.plexo
 * system-action methods directly, the same way the queue/schedule screens do. */
export function useSystemActions(): void {
  const receiveSystemActionUpdate = useAppStore((store) => store.receiveSystemActionUpdate)
  const receiveSystemActionConfig = useAppStore((store) => store.receiveSystemActionConfig)

  useEffect(() => {
    let disposed = false
    // Subscribed before the snapshot is asked for, so nothing sent in between is missed.
    const unsubscribe = window.plexo.onSystemActionUpdated(receiveSystemActionUpdate)

    void Promise.all([window.plexo.getSystemActions(), window.plexo.getSystemActionLog()])
      .then(([actions, log]) => {
        if (!disposed) receiveSystemActionConfig(actions, log)
      })
      .catch(() => {})

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [receiveSystemActionUpdate, receiveSystemActionConfig])
}
