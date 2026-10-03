import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/** Subscribes once to main-process clipboard-detection pushes for the lifetime of the app —
 * mirrors useHistory/useCategoryRules. Nothing is ever pushed while the watcher is disabled (see
 * ClipboardWatcher), so this hook costs nothing beyond the listener itself when the user has
 * clipboard watching turned off. */
export function useClipboardDetection(): void {
  const receiveClipboardDetected = useAppStore((store) => store.receiveClipboardDetected)

  useEffect(() => {
    return window.plexo.onClipboardLinkDetected(receiveClipboardDetected)
  }, [receiveClipboardDetected])
}
