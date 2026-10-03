import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/** Subscribes once to main-process queue pushes for the lifetime of the app — mirrors
 * useDownloadEvents. Screens read the result from useAppStore and call the window.plexo queue
 * methods directly, the same way the single-download screens do. */
export function useQueues(): void {
  const receiveQueuesUpdate = useAppStore((store) => store.receiveQueuesUpdate)

  useEffect(() => {
    let disposed = false
    // Subscribed before the snapshot is asked for, so nothing sent in between is missed.
    const unsubscribe = window.plexo.onQueuesUpdated(receiveQueuesUpdate)

    void window.plexo
      .getQueues()
      .then((queues) => {
        if (!disposed) receiveQueuesUpdate(queues)
      })
      .catch(() => {})

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [receiveQueuesUpdate])
}
