import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/** Subscribes once to main-process category-rule pushes for the lifetime of the app — mirrors
 * useQueues/useSchedules. Screens read the result from useAppStore and call the window.plexo
 * category-rule methods directly, the same way the queue/schedule screens do. */
export function useCategoryRules(): void {
  const receiveCategoryRulesUpdate = useAppStore((store) => store.receiveCategoryRulesUpdate)

  useEffect(() => {
    let disposed = false
    // Subscribed before the snapshot is asked for, so nothing sent in between is missed.
    const unsubscribe = window.plexo.onCategoryRulesUpdated(receiveCategoryRulesUpdate)

    void window.plexo
      .getCategoryRules()
      .then((rules) => {
        if (!disposed) receiveCategoryRulesUpdate(rules)
      })
      .catch(() => {})

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [receiveCategoryRulesUpdate])
}
