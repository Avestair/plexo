import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron'
import icon from '../../resources/icon-dark.png?asset'
import type { DownloadManager } from './download/downloadManager'
import type { QueueManager } from './queue/queueManager'

/** What the tray needs to carry out its menu actions — the same managers/window accessor
 * registerIpcHandlers already holds, never duplicated logic of their own. */
export interface TrayDeps {
  getWindow: () => BrowserWindow | null
  downloadManager: DownloadManager
  queueManager: QueueManager
}

let tray: Tray | null = null
/** Set just before a real quit (the tray's Quit item, or Cmd+Q) so the window's `close` handler
 * never mistakes it for the user clicking the OS close button and hides the window instead. In
 * practice the app's `before-quit` handler (main/index.ts) already force-exits before a window's
 * `close` event could fire, but this is cheap insurance against that ordering ever changing. */
let quitting = false

export function isQuitting(): boolean {
  return quitting
}

export function markQuitting(): void {
  quitting = true
}

export function isTrayActive(): boolean {
  return tray !== null
}

/** Pauses whatever's running: the current ad-hoc download (if any) and every active queue.
 * Reuses DownloadManager/QueueManager's own pause methods — both are already safe to call on
 * something not currently downloading/active (they just no-op), so nothing here needs to check
 * status itself beyond what getQueues()/getCurrentDownload() already report. */
async function pauseEverything(deps: TrayDeps): Promise<void> {
  const current = await deps.downloadManager.getCurrentDownload()
  const pauseCurrent =
    current && current.state.status === 'downloading'
      ? deps.downloadManager.pause(current.state.id)
      : Promise.resolve()

  const queues = await deps.queueManager.getQueues()
  const pauseQueues = queues
    .filter((queue) => queue.status === 'active')
    .map((queue) => deps.queueManager.pauseQueue(queue.id))

  await Promise.all([pauseCurrent, ...pauseQueues])
}

function toggleWindow(deps: TrayDeps): void {
  const window = deps.getWindow()
  if (!window || window.isDestroyed()) return
  if (window.isVisible()) {
    window.hide()
  } else {
    window.show()
    window.focus()
  }
}

function buildMenu(deps: TrayDeps): Menu {
  const window = deps.getWindow()
  const visible = !!window && !window.isDestroyed() && window.isVisible()
  return Menu.buildFromTemplate([
    {
      label: visible ? 'Hide' : 'Show',
      click: () => toggleWindow(deps)
    },
    { type: 'separator' },
    {
      label: 'Pause all downloads',
      click: () => void pauseEverything(deps)
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        markQuitting()
        app.quit()
      }
    }
  ])
}

/** Rebuilds the context menu so its Show/Hide label tracks the window's current visibility — call
 * whenever the main window shows or hides while a tray icon exists. A no-op when there's no tray. */
export function refreshTrayMenu(deps: TrayDeps): void {
  tray?.setContextMenu(buildMenu(deps))
}

function createTray(deps: TrayDeps): void {
  if (tray) return
  tray = new Tray(nativeImage.createFromPath(icon))
  tray.setToolTip('Plexo')
  tray.setContextMenu(buildMenu(deps))
  // Left-click toggles on platforms where that's the convention (Windows/Linux); macOS tray icons
  // are conventionally click-for-menu only, which setContextMenu already gives for free.
  if (process.platform !== 'darwin') {
    tray.on('click', () => toggleWindow(deps))
  }
}

function destroyTray(): void {
  tray?.destroy()
  tray = null
}

/** Creates or destroys the tray icon to match `enabled` — called at startup and every time
 * `minimizeToTrayOnClose` changes, so toggling the setting never needs a restart. */
export function setTrayEnabled(enabled: boolean, deps: TrayDeps): void {
  if (enabled) createTray(deps)
  else destroyTray()
}

/**
 * Exposes the exact functions the tray's menu items call, for the e2e suite to drive directly —
 * there is no way to click a real OS tray menu from Playwright (and no real tray surface renders
 * under this sandbox's Xvfb in the first place), so tests invoke this production code path
 * instead of a reimplementation of it. Guarded the same way every other test knob in this app is
 * (see testKnobs.ts): a packaged build never installs it.
 */
export function installTrayTestHooks(deps: TrayDeps): void {
  if (app.isPackaged) return
  ;(globalThis as Record<string, unknown>).__plexoTray = {
    isActive: isTrayActive,
    toggleWindow: () => toggleWindow(deps),
    pauseAll: () => pauseEverything(deps)
  }
}
