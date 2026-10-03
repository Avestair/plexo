import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'path'
import icon from '../../resources/icon-dark.png?asset'
import { registerIpcHandlers, type IpcManagers } from './ipc/handlers'
import {
  applyLoginItemSettings,
  loadSettings,
  loadThemeSource,
  migrateLegacyNetworkPreferences
} from './settings'
import { testKnobs } from './testKnobs'
import {
  installTrayTestHooks,
  isQuitting,
  isTrayActive,
  refreshTrayMenu,
  setTrayEnabled
} from './tray'
import type { ClipboardWatcher } from './clipboard/clipboardWatcher'
import type { DownloadManager } from './download/downloadManager'
import type { HistoryManager } from './history/historyManager'
import type { BandwidthManager } from './queue/bandwidthManager'
import type { CategoryRuleManager } from './queue/categoryRules'
import type { QueueManager } from './queue/queueManager'
import type { ScheduleManager } from './queue/scheduleManager'
import type { SystemActionManager } from './queue/systemActionManager'

// In dev mode the app runs as the raw `electron` binary, which otherwise shows "Electron" in
// the Dock tooltip/menu bar — must be set before the app is ready. Packaged builds already get
// this from electron-builder's productName, but setting it here keeps dev and packaged in sync.
app.setName('Plexo')

// Each e2e test runs against its own throwaway userData folder (downloads, manifests, settings).
if (testKnobs.userDataDir) app.setPath('userData', testKnobs.userDataDir)

let mainWindow: BrowserWindow | null = null
let downloadManager: DownloadManager | null = null
let queueManager: QueueManager | null = null
let scheduleManager: ScheduleManager | null = null
let systemActionManager: SystemActionManager | null = null
let bandwidthManager: BandwidthManager | null = null
let categoryRuleManager: CategoryRuleManager | null = null
let historyManager: HistoryManager | null = null
let clipboardWatcher: ClipboardWatcher | null = null
let quitAfterSuspending = false

// Non-null assertions below: every caller of this only ever runs after registerIpcHandlers has
// assigned both (at startup, or from a later 'activate'/tray action).
function currentTrayDeps(): { getWindow: () => BrowserWindow | null } & Pick<
  IpcManagers,
  'downloadManager' | 'queueManager'
> {
  return {
    getWindow: () => mainWindow,
    downloadManager: downloadManager!,
    queueManager: queueManager!
  }
}

function createWindow(startHidden: boolean): void {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 720,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    title: 'Plexo',
    // Matches the renderer's dark-mode background so a live window resize
    // (which briefly exposes the raw window background) doesn't flash white.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
    ...(process.platform !== 'darwin' ? { icon } : {}),
    // Design v2 draws its own logo + status readout where the title normally sits — on macOS,
    // keep the real traffic lights (still native, still draggable) but let the renderer's own
    // title bar occupy the rest of the strip instead of an OS-drawn title.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // A hidden e2e window would otherwise have its timers throttled.
      backgroundThrottling: !testKnobs.hideWindow
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (!testKnobs.hideWindow && !startHidden) mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // The OS close button: with a tray icon up, hide instead of quitting — the user can always get
  // the window back from the tray. Without one, this falls through to the platform's normal close
  // behavior (window-all-closed quits on non-macOS). `isQuitting()` guards the tray's own Quit
  // item/Cmd+Q, which must never be intercepted into a hide.
  mainWindow.on('close', (event) => {
    if (isQuitting() || !isTrayActive()) return
    event.preventDefault()
    mainWindow?.hide()
  })

  mainWindow.on('show', () => refreshTrayMenu(currentTrayDeps()))
  mainWindow.on('hide', () => refreshTrayMenu(currentTrayDeps()))
  // Catches a link copied while Plexo wasn't the focused window, without waiting out a full poll
  // interval — a no-op when the watcher is disabled (see ClipboardWatcher.checkNow).
  mainWindow.on('focus', () => void clipboardWatcher?.checkNow())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Only hand http(s) links to the OS shell — an arbitrary scheme (e.g. a custom protocol
    // handler) reaching shell.openExternal is a known Electron risk if this ever fires with
    // attacker- or server-influenced data.
    if (/^https?:/i.test(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.plexo.app')

  // A failed move keeps the old file, to retry next launch — it must never stop the window opening.
  await migrateLegacyNetworkPreferences().catch((error) =>
    console.error('[plexo] failed to migrate network-preferences.json', error)
  )

  // Applied before the window is created so the initial background/icon already match —
  // the saved preference otherwise only takes effect on the next 'updated' event.
  nativeTheme.themeSource = await loadThemeSource()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ;({
    downloadManager,
    queueManager,
    scheduleManager,
    systemActionManager,
    bandwidthManager,
    categoryRuleManager,
    historyManager,
    clipboardWatcher
  } = registerIpcHandlers(() => mainWindow))

  nativeTheme.on('updated', () => {
    mainWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff')
  })

  // Fixes any drift between the saved settings and the OS's actual login-item/tray state — e.g.
  // the user edited settings (or upgraded from a version without this feature) while the app
  // wasn't running. Both are also re-applied live whenever the relevant setting changes (see
  // handlers.ts's updateSettings).
  const startupSettings = await loadSettings()
  applyLoginItemSettings(startupSettings)
  setTrayEnabled(startupSettings.minimizeToTrayOnClose ?? false, currentTrayDeps())
  installTrayTestHooks(currentTrayDeps())

  createWindow(startupSettings.startMinimized ?? false)
  if (testKnobs.hideWindow) app.dock?.hide()

  app.on('activate', function () {
    // A dock/taskbar reactivation always means "show me the window" — startMinimized only applies
    // to the initial launch.
    if (BrowserWindow.getAllWindows().length === 0) createWindow(false)
    else mainWindow?.show()
  })
})

app.on('before-quit', (event) => {
  if (quitAfterSuspending || !downloadManager) return

  event.preventDefault()

  // Stopped right away rather than after the suspend/flush below — nothing it would do (start or
  // pause a queue, or fire a pending sleep/hibernate/shutdown) should happen once the app has
  // decided to quit, and a dangling timer would otherwise keep firing (and keep the process
  // alive) if the flush below ever hung.
  scheduleManager?.dispose()
  systemActionManager?.dispose()
  bandwidthManager?.dispose()
  historyManager?.dispose()
  clipboardWatcher?.dispose()

  // Guarantee the process exits even if suspending hangs
  const forceQuitTimeout = setTimeout(() => {
    app.exit(0)
  }, 3000)

  void Promise.all([
    downloadManager.suspendAll(),
    queueManager?.flush(),
    scheduleManager?.flush(),
    systemActionManager?.flush(),
    bandwidthManager?.flush(),
    categoryRuleManager?.flush(),
    historyManager?.flush()
  ]).finally(() => {
    clearTimeout(forceQuitTimeout)
    quitAfterSuspending = true
    app.exit(0)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
