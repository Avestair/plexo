import { createHash } from 'node:crypto'
import type { HashAlgorithm } from '../src/shared/types'
import { validateChecksumFormat } from '../src/shared/checksum'
import { BLOCK, expect, test } from './fixtures'

// Phase 7 — checksum verification: an optional expected hash (MD5/SHA-1/SHA-256) attached to a
// download, verified once it completes. These tests drive the same window.plexo surface the
// renderer uses (plexo.start()/plexo.api.*), plus the pure format validator directly for the
// no-download-needed case.

function hashOf(content: Buffer, algorithm: HashAlgorithm): string {
  return createHash(algorithm).update(content).digest('hex')
}

test.describe('checksum format validation (pure, no download)', () => {
  test('rejects an obviously-wrong-length hash before anything starts', () => {
    expect(validateChecksumFormat('sha256', 'deadbeef').valid).toBe(false)
    expect(validateChecksumFormat('md5', 'a'.repeat(40)).valid).toBe(false)
    expect(validateChecksumFormat('sha1', 'zz'.repeat(20)).valid).toBe(false) // not hex
  })

  test('accepts a correctly-shaped hash for each algorithm', () => {
    expect(validateChecksumFormat('md5', 'a'.repeat(32)).valid).toBe(true)
    expect(validateChecksumFormat('sha1', 'a'.repeat(40)).valid).toBe(true)
    expect(validateChecksumFormat('sha256', 'a'.repeat(64)).valid).toBe(true)
  })
})

test.describe('checksum verification @smoke', () => {
  for (const algorithm of ['md5', 'sha1', 'sha256'] as const) {
    test(`a correct ${algorithm} hash verifies as a match`, async ({ plexo, serve }) => {
      const origin = await serve({ size: 4 * BLOCK })
      const expectedHex = hashOf(origin.content, algorithm)

      await plexo.start(origin.url(), origin.sha256, {
        expectedChecksum: { algorithm, expectedHex }
      })

      const settled = await plexo.waitUntil(
        (state) => state.status === 'completed' && state.checksumStatus !== 'verifying'
      )
      expect(settled.checksumStatus).toBe('match')
      expect(settled.checksumComputedHex).toBe(expectedHex)
    })
  }

  test('a wrong hash reports a mismatch — loudly, not a silent completion', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: 4 * BLOCK })
    const wrongHex = '0'.repeat(64)

    await plexo.start(origin.url(), origin.sha256, {
      expectedChecksum: { algorithm: 'sha256', expectedHex: wrongHex }
    })

    const settled = await plexo.waitUntil(
      (state) => state.status === 'completed' && state.checksumStatus !== 'verifying'
    )
    // "Loud failure" in this app's design: the transfer itself completed (every byte the server
    // sent arrived, and the file is kept rather than discarded), but checksumStatus is the
    // unmistakable, distinct signal — never silently folded into an ordinary 'match' or left
    // unreported. The renderer surfaces this as a destructive, bold alert (see
    // ChecksumStatusBanner) rather than a small gray label.
    expect(settled.status).toBe('completed')
    expect(settled.checksumStatus).toBe('mismatch')
    expect(settled.checksumComputedHex).toBe(hashOf(origin.content, 'sha256'))
    expect(settled.checksumComputedHex).not.toBe(wrongHex)
  })

  test('no expectedChecksum means no checksum status at all', async ({ plexo, serve }) => {
    const origin = await serve({ size: BLOCK })
    await plexo.start(origin.url(), origin.sha256)
    const state = await plexo.waitForStatus('completed')
    expect(state.checksumStatus).toBeUndefined()
    expect(state.checksumComputedHex).toBeUndefined()
  })

  test('a queue item is verified the same way, and holds the slot until it settles', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: 4 * BLOCK })
    const expectedHex = hashOf(origin.content, 'sha256')
    const queue = await plexo.api.createQueue('Checksummed queue')
    const item = await plexo.api.addQueueDownload(queue.id, origin.url(), {
      algorithm: 'sha256',
      expectedHex
    })

    await plexo.api.resumeQueue(queue.id)

    await expect
      .poll(
        async () => {
          const queues = await plexo.api.getQueues()
          const found = queues.find((q) => q.id === queue.id)?.items.find((i) => i.id === item.id)
          return found?.checksumStatus
        },
        { timeout: 20_000 }
      )
      .toBe('match')

    const queues = await plexo.api.getQueues()
    const finalItem = queues.find((q) => q.id === queue.id)?.items.find((i) => i.id === item.id)
    expect(finalItem?.status).toBe('completed')
    expect(finalItem?.checksumComputedHex).toBe(expectedHex)
  })
})
