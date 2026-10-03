/**
 * Chrome/Firefox's native messaging stdio framing: each message, either direction, is a 4-byte
 * little-endian length prefix followed by that many bytes of UTF-8 JSON. Pulled out as pure
 * functions (no stdio, no sockets) so the framing itself — the one part of the native host that
 * isn't "is the local listener doing the right thing", which e2e already covers — can be sanity
 * checked on its own.
 */

/** Chrome documents a 1 MB limit on a message *sent to* a native host; nothing this app sends or
 * expects is ever remotely that large, so this is purely a guard against reading forever off a
 * misbehaving pipe. */
const MAX_MESSAGE_BYTES = 1024 * 1024

export function encodeNativeMessage(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

/** Incrementally fed chunks (as they arrive on stdin); returns a parsed message each time a full
 * frame completes. Never throws — a frame that's too large or isn't valid JSON is reported via
 * `onError` and the reader keeps going (if there's any telling where the next frame starts) rather
 * than taking the whole process down over one bad message. */
export class NativeMessageReader {
  private buffer = Buffer.alloc(0)

  feed(
    chunk: Buffer,
    onMessage: (message: unknown) => void,
    onError: (error: string) => void
  ): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.buffer.length < 4) return
      const length = this.buffer.readUInt32LE(0)
      if (length > MAX_MESSAGE_BYTES) {
        onError(`frame too large (${length} bytes)`)
        this.buffer = Buffer.alloc(0)
        return
      }
      if (this.buffer.length < 4 + length) return
      const body = this.buffer.subarray(4, 4 + length)
      this.buffer = this.buffer.subarray(4 + length)
      try {
        onMessage(JSON.parse(body.toString('utf-8')))
      } catch {
        onError('malformed JSON frame')
      }
    }
  }
}
