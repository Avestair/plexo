import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/** Subscribes once to main-process browser-integration pushes for the lifetime of the app —
 * mirrors useClipboardDetection. Nothing is ever pushed while the listener is disabled (see
 * BrowserIntegrationServer), so this hook costs nothing beyond the listener itself when the user
 * has browser integration turned off. */
export function useBrowserIntegration(): void {
  const receiveBrowserLink = useAppStore((store) => store.receiveBrowserLink)

  useEffect(() => {
    return window.plexo.onBrowserLinkReceived(receiveBrowserLink)
  }, [receiveBrowserLink])
}
