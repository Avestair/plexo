import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/** Subscribes once to main-process history pushes for the lifetime of the app — mirrors
 * useCategoryRules/useQueues. HistoryScreen reads the result from useAppStore and filters it
 * client-side (search/status), the same way CategoryRulesSection filters its own list, rather
 * than round-tripping through history:search on every keystroke. */
export function useHistory(): void {
  const receiveHistoryUpdate = useAppStore((store) => store.receiveHistoryUpdate)

  useEffect(() => {
    let disposed = false
    // Subscribed before the snapshot is asked for, so nothing sent in between is missed.
    const unsubscribe = window.plexo.onHistoryUpdated(receiveHistoryUpdate)

    void window.plexo
      .getHistory()
      .then((entries) => {
        if (!disposed) receiveHistoryUpdate(entries)
      })
      .catch(() => {})

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [receiveHistoryUpdate])
}
