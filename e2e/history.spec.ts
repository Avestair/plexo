import { BLOCK, expect, test } from './fixtures'

// Phase 7 — download history: every download that reaches a terminal state (completed, failed,
// cancelled), ad-hoc or queue-driven, is recorded once in a bounded, searchable log. See
// main/history/historyManager.ts for how an entry is produced, and historyStorage.ts for the cap.

test.describe('history recording @smoke', () => {
  test('a completed ad-hoc download is recorded with source "adhoc"', async ({ plexo, serve }) => {
    const origin = await serve({ size: BLOCK })
    await plexo.start(origin.url('/files/adhoc-one.bin'), origin.sha256)
    const state = await plexo.waitForStatus('completed')

    const history = await plexo.api.getHistory()
    const entry = history.find((e) => e.url === state.url)
    expect(entry).toBeTruthy()
    expect(entry?.source).toBe('adhoc')
    expect(entry?.status).toBe('completed')
    expect(entry?.fileName).toBe(state.fileName)
    expect(entry?.queueId).toBeUndefined()
  })

  test('a completed queue download is recorded with source "queue" and the queue name', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: BLOCK })
    const queue = await plexo.api.createQueue('History queue')
    await plexo.api.addQueueDownload(queue.id, origin.url('/files/queue-one.bin'))
    await plexo.api.resumeQueue(queue.id)

    await expect
      .poll(
        async () => {
          const queues = await plexo.api.getQueues()
          return queues.find((q) => q.id === queue.id)?.items[0]?.status
        },
        { timeout: 20_000 }
      )
      .toBe('completed')

    const history = await plexo.api.getHistory()
    const entry = history.find((e) => e.source === 'queue' && e.queueId === queue.id)
    expect(entry).toBeTruthy()
    expect(entry?.status).toBe('completed')
    expect(entry?.queueName).toBe('History queue')
  })

  test('a failed download is recorded with status "failed"', async ({ plexo, serve }) => {
    const origin = await serve({ size: BLOCK })
    origin.setRule(({ range }) =>
      range && !(range.start === 0 && range.end === 0) ? { status: 500 } : 'ok'
    )
    await plexo.start(origin.url('/files/failed-one.bin'), origin.sha256, { connections: 2 })
    const state = await plexo.waitForStatus('error')

    // Cleanup is left to fixtures.ts's automatic checkFinalState (which removes a failed
    // download once the test ends) rather than done here — removing it ourselves mid-test would
    // push a 'cancelled' update that fixtures.ts's checkEvents (run before that cleanup) does not
    // allow after 'error'.
    const history = await plexo.api.getHistory()
    const entry = history.find((e) => e.url === state.url)
    expect(entry?.status).toBe('failed')
    expect(entry?.error).toBeTruthy()
  })

  test('a cancelled download is recorded with status "cancelled"', async ({ plexo, serve }) => {
    const origin = await serve({ size: 40 * BLOCK })
    const id = await plexo.start(origin.url('/files/cancelled-one.bin'), origin.sha256)
    await plexo.api.cancelDownload(id)
    const state = await plexo.waitForStatus('cancelled')

    const history = await plexo.api.getHistory()
    const entry = history.find((e) => e.url === state.url)
    expect(entry?.status).toBe('cancelled')
  })
})

test.describe('history search @smoke', () => {
  test('matches by file name/URL substring, case-insensitively, via the IPC surface', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: BLOCK })
    await plexo.start(origin.url('/files/zebra-report.bin'), origin.sha256)
    await plexo.waitForStatus('completed')
    await plexo.api.removeDownload((await plexo.current())!.id)

    const origin2 = await serve({ size: BLOCK })
    await plexo.start(origin2.url('/files/mango-notes.bin'), origin2.sha256)
    await plexo.waitForStatus('completed')

    const byName = await plexo.api.searchHistory('ZEBRA')
    expect(byName.map((e) => e.fileName)).toContain('zebra-report.bin')
    expect(byName.map((e) => e.fileName)).not.toContain('mango-notes.bin')

    const byUrl = await plexo.api.searchHistory('mango-notes')
    expect(byUrl.map((e) => e.fileName)).toEqual(['mango-notes.bin'])

    const noMatch = await plexo.api.searchHistory('nonexistent-xyz')
    expect(noMatch).toEqual([])

    const everything = await plexo.api.searchHistory('')
    expect(everything.length).toBeGreaterThanOrEqual(2)

    const filteredByStatus = await plexo.api.searchHistory('', 'completed')
    expect(filteredByStatus.every((e) => e.status === 'completed')).toBe(true)
  })

  test('clearHistory empties the log', async ({ plexo, serve }) => {
    const origin = await serve({ size: BLOCK })
    await plexo.start(origin.url(), origin.sha256)
    await plexo.waitForStatus('completed')
    expect((await plexo.api.getHistory()).length).toBeGreaterThan(0)

    await plexo.api.clearHistory()
    expect(await plexo.api.getHistory()).toEqual([])
  })
})

test.describe('history cap @smoke', () => {
  // A real 1000-entry eviction isn't practical to drive in a test, so the cap is lowered via a
  // test-only knob (PLEXO_E2E_HISTORY_CAP) read by testKnobs.ts — the same pattern as
  // PLEXO_E2E_BLOCK_BYTES/PLEXO_E2E_STREAMS elsewhere in this suite.
  test.use({ appEnv: { PLEXO_E2E_HISTORY_CAP: '2' } })

  test('evicts the oldest entry once the cap is exceeded', async ({ plexo, serve }) => {
    const names = ['cap-first.bin', 'cap-second.bin', 'cap-third.bin']
    for (const name of names) {
      const origin = await serve({ size: BLOCK })
      await plexo.start(origin.url(`/files/${name}`), origin.sha256)
      await plexo.waitForStatus('completed')
      await plexo.api.removeDownload((await plexo.current())!.id)
    }

    const history = await plexo.api.getHistory()
    expect(history).toHaveLength(2)
    // Newest first; the oldest ("cap-first.bin") was evicted.
    expect(history.map((e) => e.fileName)).toEqual(['cap-third.bin', 'cap-second.bin'])
  })
})
