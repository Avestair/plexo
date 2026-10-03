import * as net from 'node:net'
import { parseBrowserLinkMessage } from './server'
import { browserIntegrationSocketPath } from './socketPath'
import { encodeNativeMessage, NativeMessageReader } from './nativeMessagingProtocol'

const SOCKET_TIMEOUT_MS = 3000

/** One request/response round trip against the local listener (server.ts) — connects, sends the
 * one validated line, waits for its one-line reply, and resolves to what the extension should be
 * told. Never rejects: every failure (can't connect, no reply in time) becomes an `ok: false`
 * result instead, since this always needs to produce *some* response to relay back over stdout. */
function forwardToLocalListener(message: unknown): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: { ok: boolean; error?: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }

    const path = browserIntegrationSocketPath()
    const socket = net.connect(path)
    const timer = setTimeout(
      () => finish({ ok: false, error: 'timed out reaching Plexo' }),
      SOCKET_TIMEOUT_MS
    )

    socket.on('connect', () => {
      socket.write(`${JSON.stringify(message)}\n`)
    })

    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8')
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) return
      try {
        const reply = JSON.parse(buffer.slice(0, newlineIndex)) as { ok?: unknown; error?: unknown }
        finish({
          ok: reply.ok === true,
          error: typeof reply.error === 'string' ? reply.error : undefined
        })
      } catch {
        finish({ ok: false, error: 'malformed reply from Plexo' })
      }
    })

    socket.on('error', () => {
      finish({
        ok: false,
        error: 'Plexo is not running, or browser integration is turned off in its settings'
      })
    })
  })
}

/**
 * Entry point run when Plexo's own binary is launched with `--native-messaging-host` — Chrome and
 * Firefox both start the *program named in the host manifest* and talk to it over its stdin/stdout
 * using the native messaging framing (see nativeMessagingProtocol.ts); see
 * manifestInstaller.ts for why that program is a tiny wrapper script around this same app's binary
 * rather than a separately-installed one.
 *
 * This process does exactly one thing, end to end: read one framed message from stdin, check it is
 * `{ url, suggestedFileName? }` with an http(s) URL (the same check server.ts makes — belt and
 * suspenders, since this process is the one directly exposed to whatever the browser extension
 * sends), forward it to the already-running app's local listener, and write one framed reply back
 * to stdout so the extension can show the user ok/error. It never touches the filesystem, runs no
 * other command, and opens no window of its own — see this phase's security framing for why that
 * scope is deliberate. It resolves once that's done; main/index.ts calls `app.exit(0)` right after.
 */
export function runNativeMessagingHost(): Promise<void> {
  return new Promise((resolve) => {
    const reader = new NativeMessageReader()
    let replied = false

    const reply = (payload: unknown): void => {
      if (replied) return
      replied = true
      process.stdout.write(encodeNativeMessage(payload))
      resolve()
    }

    process.stdin.on('data', (chunk: Buffer) => {
      reader.feed(
        chunk,
        (raw) => {
          if (replied) return
          const message = parseBrowserLinkMessage(raw)
          if (!message) {
            console.error('[plexo-native-host] rejected an invalid message from the browser')
            reply({ ok: false, error: 'invalid message' })
            return
          }
          void forwardToLocalListener(message).then(reply)
        },
        (error) => {
          console.error(`[plexo-native-host] ${error}`)
          reply({ ok: false, error })
        }
      )
    })

    process.stdin.on('end', () => reply({ ok: false, error: 'no message received' }))
    process.stdin.on('error', () => reply({ ok: false, error: 'stdin error' }))

    // Chrome's sendNativeMessage gives up (and disconnects) after a while if nothing comes back —
    // this must never hang forever waiting on a browser that already walked away.
    setTimeout(() => reply({ ok: false, error: 'timed out' }), 10_000)
  })
}
