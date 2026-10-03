import { unlink } from 'node:fs/promises'
import * as net from 'node:net'
import type { BrowserWindow } from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import type { BrowserLinkMessage } from '../../shared/types'
import { loadSettings, saveSettings } from '../settings'
import { browserIntegrationSocketPath } from './socketPath'

const MAX_LINE_BYTES = 8 * 1024
/** A suggested filename this long is never a real one — cut it off rather than reject the whole
 * message over it. */
const MAX_FILENAME_LENGTH = 255

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The ONLY thing this ever accepts is "here is a URL" (optionally with a suggested filename) —
 * see this module's and this phase's doc for the threat model. Anything else — a different shape,
 * extra fields, a non-http(s) scheme — is rejected without acting on it and without throwing.
 */
export function parseBrowserLinkMessage(raw: unknown): BrowserLinkMessage | null {
  if (!isPlainObject(raw)) return null
  const { url, suggestedFileName } = raw
  if (typeof url !== 'string') return null

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  const message: BrowserLinkMessage = { url: parsed.toString() }
  if (typeof suggestedFileName === 'string' && suggestedFileName.trim()) {
    // Defensive hygiene only — this is never used as a filesystem path by anything that reads it
    // (it only ever pre-fills a text field the user still has to press Start on), but stripping
    // path separators and control characters means it can never even look like one.
    const cleaned = suggestedFileName
      .replace(/[\\/]/g, '-')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f]/g, '')
      .trim()
      .slice(0, MAX_FILENAME_LENGTH)
    if (cleaned) message.suggestedFileName = cleaned
  }
  return message
}

/**
 * The local listener a native messaging host process (see nativeHostMain.ts) connects to, so a
 * link the user explicitly sent from their browser can reach the already-running app without the
 * browser or its extension ever touching IPC, settings, or anything else of Plexo's.
 *
 * Transport: a Unix domain socket (named pipe on Windows) under the app's own userData directory
 * — see socketPath.ts for exactly why that's a safe boundary on each OS. Deliberately not a TCP
 * socket on 127.0.0.1: even bound to loopback, a TCP port is visible to (and connectable by) every
 * other local user and process on a shared machine, where a Unix socket under a user-owned
 * directory (or a Windows pipe with its default per-user DACL) is not.
 *
 * Protocol: one connection, one line of UTF-8 JSON terminated by '\n', and exactly one '\n'
 * terminated JSON reply (`{ok:true}` or `{ok:false,error}`) before the socket is closed. This is
 * intentionally the simplest framing that works for a single request/response — the 4-byte
 * length-prefixed framing used on the native-messaging side (nativeHostMain.ts) is a constraint of
 * that *browser-facing* protocol, not something this purely-local hop needs to replicate.
 *
 * Validation is the actual security boundary: whatever arrives is run through
 * parseBrowserLinkMessage, which accepts nothing but `{ url: string, suggestedFileName?: string }`
 * where `url` parses as an http(s) URL — never anything that could be mistaken for a command,
 * a file path, or a config change. Malformed JSON, an oversized line, or a rejected message is
 * logged and answered with `{ok:false}` — never thrown, never left to crash the server.
 *
 * Off by default (AppSettings.browserIntegrationEnabled) and, like ClipboardWatcher, fully torn
 * down rather than merely hidden when disabled: setEnabled(false) closes the server and removes
 * the socket file, so a connection attempt while off gets ECONNREFUSED/ENOENT, not a socket that
 * quietly accepts but ignores.
 */
export class BrowserIntegrationServer {
  private enabled = false
  private server: net.Server | null = null
  private readonly initialization: Promise<void>
  private disposed = false

  constructor(private getWindow: () => BrowserWindow | null) {
    this.initialization = this.restore()
  }

  private async restore(): Promise<void> {
    const settings = await loadSettings()
    await this.applyEnabled(settings.browserIntegrationEnabled ?? false)
  }

  async getEnabled(): Promise<boolean> {
    await this.initialization
    return this.enabled
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.initialization
    await this.applyEnabled(enabled)
    await saveSettings({ browserIntegrationEnabled: enabled })
  }

  private async applyEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled
    if (!enabled) {
      await this.closeServer()
      return
    }
    if (this.server || this.disposed) return
    await this.startServer()
  }

  private async startServer(): Promise<void> {
    const path = browserIntegrationSocketPath()
    // A socket file left behind by an unclean previous exit (crash, SIGKILL) would otherwise make
    // listen() fail with EADDRINUSE even though nothing is actually listening on it any more.
    if (process.platform !== 'win32') await unlink(path).catch(() => {})

    const server = net.createServer((socket) => this.handleConnection(socket))
    server.on('error', (error) => {
      console.error('[plexo] browser-integration listener error', error)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.removeListener('error', reject)
        resolve()
      })
    }).catch((error: unknown) => {
      console.error('[plexo] failed to start browser-integration listener', error)
    })
    this.server = server
  }

  private async closeServer(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (process.platform !== 'win32') {
      await unlink(browserIntegrationSocketPath()).catch(() => {})
    }
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = ''
    let handled = false

    const reply = (payload: { ok: true } | { ok: false; error: string }): void => {
      if (socket.writable) socket.write(`${JSON.stringify(payload)}\n`)
      socket.end()
    }

    socket.on('data', (chunk: Buffer) => {
      if (handled) return
      buffer += chunk.toString('utf-8')
      if (buffer.length > MAX_LINE_BYTES) {
        handled = true
        console.error('[plexo] browser-integration message too large — ignored')
        reply({ ok: false, error: 'message too large' })
        return
      }
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) return
      handled = true

      const line = buffer.slice(0, newlineIndex)
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        console.error('[plexo] browser-integration received malformed JSON — ignored')
        reply({ ok: false, error: 'malformed JSON' })
        return
      }

      const message = parseBrowserLinkMessage(parsed)
      if (!message) {
        console.error('[plexo] browser-integration rejected an invalid message')
        reply({ ok: false, error: 'invalid message' })
        return
      }

      this.deliver(message)
      reply({ ok: true })
    })

    socket.on('error', () => {
      // A client that disconnects mid-write, or never sends a full line — nothing to act on and
      // nothing worth crashing the listener over.
    })
  }

  private deliver(message: BrowserLinkMessage): void {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return
    if (!window.isVisible()) window.show()
    window.focus()
    window.webContents.send(IpcChannels.browserLinkReceived, message)
  }

  /** Stops the listener — for app shutdown. */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.closeServer()
  }
}
