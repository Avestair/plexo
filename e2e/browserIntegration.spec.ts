import { existsSync } from 'node:fs'
import * as net from 'node:net'
import { join } from 'node:path'
import { expect, test, type PlexoApp } from './fixtures'

// Phase 8 — browser integration: a native-messaging host (never exercised directly here — see
// browser-extension/README.md for exactly why Chrome/Firefox's own extension-loading UI can't be
// driven from this sandbox) forwards one validated `{ url, suggestedFileName? }` message at a time
// to a local listener inside the already-running app (BrowserIntegrationServer). These tests act as
// that host themselves: connecting straight to the local socket with Node's own `net` module, the
// same way nativeHostMain.ts does, with no real native messaging host process or browser involved.

function socketPathFor(plexo: PlexoApp): string {
  // Mirrors browserIntegrationSocketPath() on Linux/macOS — app.getPath('userData') is this exact
  // directory in every e2e run (see testKnobs.ts's PLEXO_USER_DATA). This suite only runs on Linux
  // (xvfb-run), so the Windows named-pipe branch is never relevant here.
  return join(plexo.dirs.userData, 'browser-integration.sock')
}

/** One request/response round trip against the local listener, exactly as nativeHostMain.ts makes
 * one — connect, write one line, read one line back, close. Rejects (rather than hanging forever)
 * on a connection error, so "the socket doesn't exist" surfaces as a rejection a test can assert
 * on directly. */
function sendRaw(socketPath: string, line: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('timed out waiting for a reply'))
    }, 5000)

    socket.on('connect', () => socket.write(line))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8')
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) return
      clearTimeout(timer)
      socket.end()
      try {
        resolve(JSON.parse(buffer.slice(0, newlineIndex)))
      } catch (error) {
        reject(error)
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function sendMessage(
  socketPath: string,
  message: unknown
): Promise<{ ok: boolean; error?: string }> {
  return sendRaw(socketPath, `${JSON.stringify(message)}\n`)
}

async function recordBrowserLinks(plexo: PlexoApp): Promise<() => string[]> {
  const received: string[] = []
  await plexo.page.exposeFunction('__plexoBrowserLinkReceived', (url: string) => {
    received.push(url)
  })
  await plexo.page.evaluate(() => {
    const w = window as unknown as { __plexoBrowserLinkReceived: (url: string) => void }
    window.plexo.onBrowserLinkReceived((message) => w.__plexoBrowserLinkReceived(message.url))
  })
  return () => received
}

test.describe('browser integration @smoke', () => {
  test('a valid URL reaches the renderer and shows/focuses the window', async ({ plexo }) => {
    const getReceived = await recordBrowserLinks(plexo)
    await plexo.api.setBrowserIntegrationEnabled(true)
    const socketPath = socketPathFor(plexo)
    await expect.poll(() => existsSync(socketPath)).toBe(true)

    const reply = await sendMessage(socketPath, { url: 'https://example.com/a-file.zip' })
    expect(reply).toEqual({ ok: true })

    await expect.poll(() => getReceived()).toEqual(['https://example.com/a-file.zip'])

    const visible = await plexo.evaluateMain(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible()),
      undefined
    )
    expect(visible).toBe(true)
  })

  test('a suggested filename is accepted and does not change the result', async ({ plexo }) => {
    await plexo.api.setBrowserIntegrationEnabled(true)
    const socketPath = socketPathFor(plexo)
    await expect.poll(() => existsSync(socketPath)).toBe(true)

    const reply = await sendMessage(socketPath, {
      url: 'https://example.com/movie.mkv',
      suggestedFileName: 'movie.mkv'
    })
    expect(reply).toEqual({ ok: true })
  })

  test('malformed JSON is ignored without crashing the listener', async ({ plexo }) => {
    const getReceived = await recordBrowserLinks(plexo)
    await plexo.api.setBrowserIntegrationEnabled(true)
    const socketPath = socketPathFor(plexo)
    await expect.poll(() => existsSync(socketPath)).toBe(true)

    const reply = await sendRaw(socketPath, 'this is not JSON at all\n')
    expect(reply.ok).toBe(false)

    // The listener must still be alive and answering correctly afterwards.
    const second = await sendMessage(socketPath, { url: 'https://example.com/still-works.zip' })
    expect(second).toEqual({ ok: true })
    await expect.poll(() => getReceived()).toEqual(['https://example.com/still-works.zip'])
  })

  test('a non-http(s) "URL" is rejected and never reaches the renderer', async ({ plexo }) => {
    const getReceived = await recordBrowserLinks(plexo)
    await plexo.api.setBrowserIntegrationEnabled(true)
    const socketPath = socketPathFor(plexo)
    await expect.poll(() => existsSync(socketPath)).toBe(true)

    const ftpReply = await sendMessage(socketPath, { url: 'ftp://example.com/file.zip' })
    expect(ftpReply.ok).toBe(false)

    const notAUrlReply = await sendMessage(socketPath, { url: 'not a url' })
    expect(notAUrlReply.ok).toBe(false)

    const missingUrlReply = await sendMessage(socketPath, { suggestedFileName: 'x.zip' })
    expect(missingUrlReply.ok).toBe(false)

    // Give any (incorrect) async delivery a moment to arrive before asserting none did.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(getReceived()).toEqual([])
  })

  test('the listener does not exist at all while the setting is off', async ({ plexo }) => {
    expect(await plexo.api.getBrowserIntegrationEnabled()).toBe(false)
    const socketPath = socketPathFor(plexo)
    expect(existsSync(socketPath)).toBe(false)

    await expect(
      sendMessage(socketPath, { url: 'https://example.com/while-disabled.zip' })
    ).rejects.toThrow()
  })

  test('enabling opens the listener and disabling closes it again, not just the UI', async ({
    plexo
  }) => {
    const socketPath = socketPathFor(plexo)
    expect(existsSync(socketPath)).toBe(false)

    await plexo.api.setBrowserIntegrationEnabled(true)
    await expect.poll(() => existsSync(socketPath)).toBe(true)
    await expect(sendMessage(socketPath, { url: 'https://example.com/ok.zip' })).resolves.toEqual({
      ok: true
    })

    await plexo.api.setBrowserIntegrationEnabled(false)
    await expect.poll(() => existsSync(socketPath)).toBe(false)
    await expect(
      sendMessage(socketPath, { url: 'https://example.com/after-off.zip' })
    ).rejects.toThrow()
  })

  test('the setting persists across a relaunch', async ({ plexo }) => {
    await plexo.api.setBrowserIntegrationEnabled(true)
    await plexo.relaunch()
    expect(await plexo.api.getBrowserIntegrationEnabled()).toBe(true)
    await expect.poll(() => existsSync(socketPathFor(plexo))).toBe(true)
  })
})
