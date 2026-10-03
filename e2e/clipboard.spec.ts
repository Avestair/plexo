import { expect, test } from './fixtures'

// Phase 7 — clipboard link detection: polls (or is nudged, via checkClipboardNow/window focus)
// for a URL-shaped clipboard change and offers it once, never twice for the same content, and
// never at all while the user has the watcher turned off. The clipboard is written through
// evaluateMain (Electron's own clipboard module, in the main process) rather than through browser
// clipboard permissions, which Electron's renderer sandbox doesn't grant by default.

async function recordDetections(plexo: import('./fixtures').PlexoApp): Promise<() => string[]> {
  const received: string[] = []
  await plexo.page.exposeFunction('__plexoClipboardDetected', (url: string) => {
    received.push(url)
  })
  await plexo.page.evaluate(() => {
    const w = window as unknown as { __plexoClipboardDetected: (url: string) => void }
    window.plexo.onClipboardLinkDetected((url) => w.__plexoClipboardDetected(url))
  })
  return () => received
}

async function writeClipboardText(
  plexo: import('./fixtures').PlexoApp,
  text: string
): Promise<void> {
  await plexo.evaluateMain(({ clipboard }, value) => clipboard.writeText(value), text)
}

test.describe('clipboard link detection @smoke', () => {
  test('a URL written to the clipboard is detected once checkClipboardNow runs', async ({
    plexo
  }) => {
    const getReceived = await recordDetections(plexo)
    await plexo.api.setClipboardWatchEnabled(true)

    await writeClipboardText(plexo, 'https://example.com/a-file.zip')
    await plexo.api.checkClipboardNow()

    await expect.poll(() => getReceived()).toEqual(['https://example.com/a-file.zip'])
  })

  test('writing the exact same URL again does not re-trigger', async ({ plexo }) => {
    const getReceived = await recordDetections(plexo)
    await plexo.api.setClipboardWatchEnabled(true)

    await writeClipboardText(plexo, 'https://example.com/same.zip')
    await plexo.api.checkClipboardNow()
    await expect.poll(() => getReceived()).toEqual(['https://example.com/same.zip'])

    // Same content again — the clipboard "changing" to the same text it already was.
    await writeClipboardText(plexo, 'https://example.com/same.zip')
    await plexo.api.checkClipboardNow()
    // And once more after something else was copied in between, to confirm the dedup is
    // per-URL (never offered twice), not merely "unchanged since last poll".
    await writeClipboardText(plexo, 'https://example.com/different.zip')
    await plexo.api.checkClipboardNow()
    await writeClipboardText(plexo, 'https://example.com/same.zip')
    await plexo.api.checkClipboardNow()

    await expect
      .poll(() => getReceived())
      .toEqual(['https://example.com/same.zip', 'https://example.com/different.zip'])
  })

  test('a non-URL clipboard change is ignored', async ({ plexo }) => {
    const getReceived = await recordDetections(plexo)
    await plexo.api.setClipboardWatchEnabled(true)

    await writeClipboardText(plexo, 'just some notes, not a link')
    await plexo.api.checkClipboardNow()
    await writeClipboardText(plexo, 'ftp://example.com/not-http.zip')
    await plexo.api.checkClipboardNow()

    // Give any (incorrect) async detection a moment to arrive before asserting none did.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(getReceived()).toEqual([])
  })

  test('disabling the watcher stops detection entirely, not just the UI', async ({ plexo }) => {
    const getReceived = await recordDetections(plexo)
    await plexo.api.setClipboardWatchEnabled(false)
    expect(await plexo.api.getClipboardWatchEnabled()).toBe(false)

    await writeClipboardText(plexo, 'https://example.com/while-disabled.zip')
    await plexo.api.checkClipboardNow()

    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(getReceived()).toEqual([])

    // Turning it back on and re-checking (against a clipboard that hasn't changed since it was
    // seeded at enable time) still correctly finds nothing new until the clipboard actually
    // changes again.
    await plexo.api.setClipboardWatchEnabled(true)
    await writeClipboardText(plexo, 'https://example.com/after-enable.zip')
    await plexo.api.checkClipboardNow()
    await expect.poll(() => getReceived()).toEqual(['https://example.com/after-enable.zip'])
  })

  test('the setting persists across a relaunch', async ({ plexo }) => {
    await plexo.api.setClipboardWatchEnabled(true)
    await plexo.relaunch()
    expect(await plexo.api.getClipboardWatchEnabled()).toBe(true)
  })

  test('dismissClipboardDetected marks a URL as handled', async ({ plexo }) => {
    const getReceived = await recordDetections(plexo)
    await plexo.api.setClipboardWatchEnabled(true)

    await writeClipboardText(plexo, 'https://example.com/dismiss-me.zip')
    await plexo.api.checkClipboardNow()
    await expect.poll(() => getReceived()).toEqual(['https://example.com/dismiss-me.zip'])

    await plexo.api.dismissClipboardDetected('https://example.com/dismiss-me.zip')

    // Clipboard changes away and back to the dismissed URL — still never re-offered.
    await writeClipboardText(plexo, 'https://example.com/other.zip')
    await plexo.api.checkClipboardNow()
    await writeClipboardText(plexo, 'https://example.com/dismiss-me.zip')
    await plexo.api.checkClipboardNow()

    await expect
      .poll(() => getReceived())
      .toEqual(['https://example.com/dismiss-me.zip', 'https://example.com/other.zip'])
  })
})
