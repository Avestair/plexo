import type { Queue } from '../src/shared/types'
import { BLOCK, expect, test, type PlexoApp } from './fixtures'

// Phase 5: system tray, start-on-login, start-minimized. What's covered here, and why:
//
// - Settings persistence (round-trips through updateSettings/getSettings, survives a relaunch) is
//   fully testable headlessly, the same as every other setting in this app.
// - The tray's menu actions (pause-all, show/hide) are production code (see main/tray.ts) driven
//   directly through a test-only hook (`globalThis.__plexoTray`, installed only when
//   !app.isPackaged — see installTrayTestHooks), the same real functions the tray's context menu
//   items are wired to. There is no way to click a real OS tray menu from Playwright, and this
//   sandbox's Xvfb has no systray surface for a Tray icon to render into in the first place (tried
//   directly: `new Tray(...)` succeeds without throwing, but nothing draws anywhere meaningful —
//   there's no notification area to draw into), so asserting on the drawn icon itself isn't
//   possible here. What *is* real and asserted below: the Tray object's actual lifecycle (created
//   and destroyed exactly when `minimizeToTrayOnClose` is toggled or loaded at startup) and the
//   real pause/show/hide logic it calls.
// - The close-to-tray window behavior is tested for real: one block below runs with the window
//   actually shown (overriding the suite's default PLEXO_E2E_HIDE_WINDOW) and checks genuine
//   `BrowserWindow.isVisible()` transitions through a real `close` event.
// - `app.setLoginItemSettings`/`getLoginItemSettings` are Electron APIs that are a no-op on Linux
//   (which is what this sandbox is, confirmed via Electron's own docs and by this suite's
//   platform fixture) and so can't be asserted on for real here beyond "the app never crashes
//   calling them" — covered implicitly by every test in this file (and this whole suite) launching
//   and running the app at all with startOnLogin toggled on/off in the mix.

// Each function below is serialized and re-run inside the main process (Playwright's
// electronApp.evaluate), so it can only reference its own body, the passed arg, and main-process
// globals — never anything closed over from this file's module scope (e.g. a shared helper that
// reads `globalThis.__plexoTray` would not exist over there). Each one re-reads the hook itself.
interface PlexoTrayTestHook {
  isActive: () => boolean
  pauseAll: () => Promise<void>
  toggleWindow: () => void
}

const trayActive = (plexo: PlexoApp): Promise<boolean> =>
  plexo.evaluateMain(
    () => (globalThis as unknown as { __plexoTray: PlexoTrayTestHook }).__plexoTray.isActive(),
    null
  )

const pauseAllViaTray = (plexo: PlexoApp): Promise<void> =>
  plexo.evaluateMain(() => {
    void (globalThis as unknown as { __plexoTray: PlexoTrayTestHook }).__plexoTray.pauseAll()
  }, null)

const toggleWindowViaTray = (plexo: PlexoApp): Promise<void> =>
  plexo.evaluateMain(() => {
    ;(globalThis as unknown as { __plexoTray: PlexoTrayTestHook }).__plexoTray.toggleWindow()
  }, null)

function itemStatus(queue: Queue, itemId: string): string | undefined {
  return queue.items.find((item) => item.id === itemId)?.status
}

async function waitForQueue(
  plexo: PlexoApp,
  queueId: string,
  predicate: (queue: Queue) => boolean,
  timeout = 20_000
): Promise<Queue> {
  const deadline = Date.now() + timeout
  let last: Queue | undefined
  while (Date.now() < deadline) {
    const queues = await plexo.api.getQueues()
    last = queues.find((queue) => queue.id === queueId)
    if (last && predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting on queue ${queueId}. Last seen: ${JSON.stringify(last)}`)
}

test.describe('platform settings persistence @smoke', () => {
  test('tray/login/start-minimized settings round-trip and survive a relaunch', async ({
    plexo
  }) => {
    const fresh = await plexo.api.getSettings()
    expect(fresh.minimizeToTrayOnClose).toBeUndefined()
    expect(fresh.startOnLogin).toBeUndefined()
    expect(fresh.startMinimized).toBeUndefined()

    await plexo.api.updateSettings({
      minimizeToTrayOnClose: true,
      startOnLogin: true,
      startMinimized: true
    })
    expect(await plexo.api.getSettings()).toMatchObject({
      minimizeToTrayOnClose: true,
      startOnLogin: true,
      startMinimized: true
    })

    await plexo.relaunch()
    expect(await plexo.api.getSettings()).toMatchObject({
      minimizeToTrayOnClose: true,
      startOnLogin: true,
      startMinimized: true
    })

    // Flip them back off — round-trips the other way too, and leaves login-item registration
    // (best-effort on this platform) turned off again rather than stuck on from this test.
    await plexo.api.updateSettings({
      minimizeToTrayOnClose: false,
      startOnLogin: false,
      startMinimized: false
    })
    expect(await plexo.api.getSettings()).toMatchObject({
      minimizeToTrayOnClose: false,
      startOnLogin: false,
      startMinimized: false
    })
  })

  test('each setting is independent of the others', async ({ plexo }) => {
    await plexo.api.updateSettings({ startMinimized: true })
    let settings = await plexo.api.getSettings()
    expect(settings.minimizeToTrayOnClose).toBeUndefined()
    expect(settings.startOnLogin).toBeUndefined()
    expect(settings.startMinimized).toBe(true)

    await plexo.api.updateSettings({ startOnLogin: true })
    settings = await plexo.api.getSettings()
    expect(settings.minimizeToTrayOnClose).toBeUndefined()
    expect(settings.startOnLogin).toBe(true)
    expect(settings.startMinimized).toBe(true)
  })
})

test.describe('tray lifecycle @smoke', () => {
  test('off by default; toggling the setting creates/destroys the real Tray object', async ({
    plexo
  }) => {
    expect(await trayActive(plexo)).toBe(false)

    await plexo.api.updateSettings({ minimizeToTrayOnClose: true })
    expect(await trayActive(plexo)).toBe(true)

    await plexo.api.updateSettings({ minimizeToTrayOnClose: false })
    expect(await trayActive(plexo)).toBe(false)
  })

  test('a tray enabled before a relaunch is recreated at startup, no setting change needed', async ({
    plexo
  }) => {
    await plexo.api.updateSettings({ minimizeToTrayOnClose: true })
    await plexo.relaunch()
    expect(await trayActive(plexo)).toBe(true)
  })
})

test.describe('pause all from the tray @smoke', () => {
  test('pauses the current ad-hoc download', async ({ plexo, serve }) => {
    const origin = await serve({ size: 24 * BLOCK })
    const reached = origin.hold(6 * BLOCK)
    const id = await plexo.start(origin.url(), origin.sha256, { connections: 2 })
    await reached

    await pauseAllViaTray(plexo)
    const paused = await plexo.waitForStatus('paused')
    expect(paused.id).toBe(id)
    origin.release()
    await plexo.api.resumeDownload(id)
    await plexo.waitForStatus('completed')
  })

  test('pauses every active queue', async ({ plexo, serve }) => {
    const origin = await serve({ size: 24 * BLOCK })
    const reached = origin.hold(6 * BLOCK)
    const queue = await plexo.api.createQueue('Tray pause')
    const item = await plexo.api.addQueueDownload(queue.id, origin.url())
    await plexo.api.resumeQueue(queue.id)
    await reached

    await pauseAllViaTray(plexo)
    const paused = await waitForQueue(plexo, queue.id, (q) => q.status === 'paused')
    expect(itemStatus(paused, item.id)).toBe('paused')

    origin.release()
    await plexo.api.resumeQueue(queue.id)
    await waitForQueue(plexo, queue.id, (q) => itemStatus(q, item.id) === 'completed')
  })

  test('is a no-op when nothing is running', async ({ plexo }) => {
    // Just must not throw with no current download and no queues.
    await pauseAllViaTray(plexo)
    expect(await plexo.api.getCurrentDownload()).toBeNull()
  })
})

test.describe('close-to-tray window behavior @smoke', () => {
  test('without a tray, closing the window is unaffected (still lets the app quit)', async ({
    plexo
  }) => {
    const exited = new Promise<void>((resolve) => {
      plexo.electronApp.process().once('exit', () => resolve())
    })
    await plexo.evaluateMain((electron) => {
      electron.BrowserWindow.getAllWindows()[0]?.close()
    }, null)
    await exited
    plexo.alive = false
  })

  test('with a tray, closing the window hides it instead of quitting', async ({ plexo }) => {
    await plexo.api.updateSettings({ minimizeToTrayOnClose: true })

    await plexo.evaluateMain((electron) => {
      electron.BrowserWindow.getAllWindows()[0]?.close()
    }, null)

    // The app must still be alive and the window still exist (not destroyed) — only genuinely
    // hidden, not quit. A short poll rather than an immediate check: the close handler's
    // preventDefault + hide() happens synchronously in the handler, but give it a moment either way.
    await expect
      .poll(() =>
        plexo.evaluateMain((electron) => electron.BrowserWindow.getAllWindows().length, null)
      )
      .toBe(1)
    expect(await plexo.api.getPlatform()).toBeTruthy() // IPC still answers — the app is alive
  })

  test('real window visibility: close hides it, the tray Show action brings it back', async ({
    plexo
  }) => {
    // Overrides the suite default (PLEXO_E2E_HIDE_WINDOW=1, which never calls show() at all) so
    // this one test exercises the window's real, observable visibility under Xvfb.
    await plexo.relaunch({ PLEXO_E2E_HIDE_WINDOW: '0' })
    await plexo.api.updateSettings({ minimizeToTrayOnClose: true })

    const isVisible = (): Promise<boolean> =>
      plexo.evaluateMain(
        (electron) => electron.BrowserWindow.getAllWindows()[0]?.isVisible() ?? false,
        null
      )

    await expect.poll(isVisible, { message: 'window shows on launch' }).toBe(true)

    await plexo.evaluateMain((electron) => {
      electron.BrowserWindow.getAllWindows()[0]?.close()
    }, null)
    await expect.poll(isVisible, { message: 'close hides instead of quitting' }).toBe(false)

    await toggleWindowViaTray(plexo)
    await expect.poll(isVisible, { message: 'tray Show brings it back' }).toBe(true)
  })
})
