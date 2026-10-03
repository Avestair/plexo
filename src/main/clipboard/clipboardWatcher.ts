import { clipboard, type BrowserWindow } from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import { loadSettings, saveSettings } from '../settings'

// Polled this often while enabled, and also checked once right when the window regains focus
// (see main/index.ts's 'focus' listener) — catching a link copied while Plexo wasn't the active
// window without waiting out a full poll interval. 2s is frequent enough that "copy a link, alt-
// tab back" feels responsive, without reading the clipboard so often it shows up as a measurable
// background cost.
const POLL_MS = 2000

function looksLikeDownloadUrl(text: string): boolean {
  if (!/^https?:\/\//i.test(text)) return false
  try {
    new URL(text)
    return true
  } catch {
    return false
  }
}

/**
 * Polls the clipboard for a URL that looks like a download link and, when it's a genuinely new
 * one, pushes it to the renderer as a dismissible suggestion (see IpcChannels.clipboardLinkDetected
 * and useClipboardDetection/the banner in App.tsx) rather than ever adding or starting anything
 * itself — the user always chooses whether to act on it.
 *
 * Off by default (see AppSettings.clipboardWatchEnabled's doc) and the interval genuinely doesn't
 * run while off — setEnabled(false) clears it rather than merely suppressing the resulting UI, so
 * a user who leaves it off never has Plexo reading their clipboard at all.
 *
 * Dedup: `lastSeenText` is compared on every poll so an unchanged clipboard is a no-op, and
 * `offeredUrls` remembers every URL this session has ever offered or that the user explicitly
 * dismissed (see dismiss()) so none of them is ever offered a second time — copying the same link
 * again later, even after copying something else in between, does not re-prompt. This set is
 * session-only (not persisted): a relaunch starts fresh, which is the right trade-off for what is
 * meant to be a lightweight nudge, not a tracked history of every link ever seen.
 */
export class ClipboardWatcher {
  private enabled = false
  private timer: NodeJS.Timeout | null = null
  private lastSeenText: string | null = null
  private readonly offeredUrls = new Set<string>()
  private readonly initialization: Promise<void>
  private disposed = false

  constructor(private getWindow: () => BrowserWindow | null) {
    this.initialization = this.restore()
  }

  private async restore(): Promise<void> {
    const settings = await loadSettings()
    await this.applyEnabled(settings.clipboardWatchEnabled ?? false)
  }

  async getEnabled(): Promise<boolean> {
    await this.initialization
    return this.enabled
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.initialization
    await this.applyEnabled(enabled)
    await saveSettings({ clipboardWatchEnabled: enabled })
  }

  private async applyEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled
    if (!enabled) {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      return
    }
    if (this.timer || this.disposed) return
    // Seeds with whatever is on the clipboard right now, so turning the watcher on doesn't
    // immediately re-offer something copied long before it was enabled. Awaited before the
    // interval starts so setEnabled(true) can't race its own first checkNow() call.
    this.lastSeenText = await this.readClipboardSafe()
    this.timer = setInterval(() => void this.checkNow(), POLL_MS)
  }

  private async readClipboardSafe(): Promise<string | null> {
    try {
      // Electron's clipboard.readText() is promise-based (modeled on navigator.clipboard) in the
      // version this app ships — see electron.d.ts's Clipboard interface.
      return await clipboard.readText()
    } catch {
      // No clipboard access (a sandboxed/headless session) — nothing to detect.
      return null
    }
  }

  /** Runs one check right now instead of waiting for the poll interval — what main/index.ts calls
   * on window focus, and the escape hatch that makes this testable without sleeping out a real
   * interval (same pattern as ScheduleManager.checkNow). A no-op while disabled, so a test (or a
   * focus event) can call it unconditionally. */
  async checkNow(): Promise<void> {
    if (!this.enabled) return
    const text = await this.readClipboardSafe()
    if (text === null || text === this.lastSeenText) return
    this.lastSeenText = text
    const trimmed = text.trim()
    if (!looksLikeDownloadUrl(trimmed) || this.offeredUrls.has(trimmed)) return
    this.offeredUrls.add(trimmed)
    const window = this.getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(IpcChannels.clipboardLinkDetected, trimmed)
    }
  }

  /** The renderer's "I've handled this" signal (accepted into the add-download flow, or
   * dismissed) — marks `url` as offered so it can never trigger a second prompt, matching what
   * checkNow() already does for a URL it offers itself. Exposed separately so a URL can be
   * suppressed without it ever having gone through checkNow() (e.g. pre-emptively, from the
   * renderer's own state) even though in practice that never happens today. */
  dismiss(url: string): void {
    this.offeredUrls.add(url)
  }

  /** Stops the interval — for app shutdown. */
  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
