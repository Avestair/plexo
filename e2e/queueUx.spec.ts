import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { matchCategoryRule } from '../src/shared/categoryRules'
import type { CategoryRule, Queue } from '../src/shared/types'
import { expect, test } from './fixtures'

// Phase 6 — queue/download UX polish: batch import of URLs into a queue, and category rules that
// auto-route a URL to a queue. Drag-and-drop reordering is covered separately in ui.spec.ts-style
// fashion below, to the extent a headless HTML5 drag gesture can be driven at all (see that
// describe block's own comment for what was and wasn't practical here). These tests drive the
// queue:*/categoryRule:* IPC surface directly (window.plexo), the same contract the renderer's
// screens call — never main-process internals.

function itemUrls(queue: Queue | undefined): string[] {
  return queue?.items.map((item) => item.url) ?? []
}

test.describe('batch import @smoke', () => {
  test('adds valid URLs, ignores blank lines, reports an invalid one', async ({ plexo }) => {
    const queue = await plexo.api.createQueue('Batch')
    const lines = ['https://example.com/a.zip', '', '   ', 'not-a-url', 'https://example.com/b.zip']

    const result = await plexo.api.addQueueDownloads(queue.id, lines)

    expect(result.added.map((item) => item.url)).toEqual([
      'https://example.com/a.zip',
      'https://example.com/b.zip'
    ])
    expect(result.skipped).toEqual([{ url: 'not-a-url', reason: 'invalid' }])

    const queues = await plexo.api.getQueues()
    expect(itemUrls(queues.find((q) => q.id === queue.id))).toEqual([
      'https://example.com/a.zip',
      'https://example.com/b.zip'
    ])
  })

  test('dedupes within the batch and against what the queue already has', async ({ plexo }) => {
    const queue = await plexo.api.createQueue('Dedup')
    await plexo.api.addQueueDownload(queue.id, 'https://example.com/existing.zip')

    const result = await plexo.api.addQueueDownloads(queue.id, [
      'https://example.com/existing.zip', // already in the queue
      'https://example.com/new.zip',
      'https://example.com/new.zip', // repeated later in the same batch
      'https://example.com/other.zip'
    ])

    expect(result.added.map((item) => item.url)).toEqual([
      'https://example.com/new.zip',
      'https://example.com/other.zip'
    ])
    expect(result.skipped).toEqual([
      { url: 'https://example.com/existing.zip', reason: 'duplicate' },
      { url: 'https://example.com/new.zip', reason: 'duplicate' }
    ])

    const queues = await plexo.api.getQueues()
    expect(itemUrls(queues.find((q) => q.id === queue.id))).toEqual([
      'https://example.com/existing.zip',
      'https://example.com/new.zip',
      'https://example.com/other.zip'
    ])
  })

  test('a batch of nothing but invalid/blank lines adds nothing and crashes nothing', async ({
    plexo
  }) => {
    const queue = await plexo.api.createQueue('All bad')
    const result = await plexo.api.addQueueDownloads(queue.id, ['', '   ', 'nope', 'ftp://x/y'])
    expect(result.added).toEqual([])
    expect(result.skipped.map((entry) => entry.url)).toEqual(['nope', 'ftp://x/y'])

    const queues = await plexo.api.getQueues()
    expect(itemUrls(queues.find((q) => q.id === queue.id))).toEqual([])
  })

  test('addDownloads against an unknown queue rejects rather than silently doing nothing', async ({
    plexo
  }) => {
    await expect(
      plexo.api.addQueueDownloads('nope', ['https://example.com/a.zip'])
    ).rejects.toThrow()
  })

  test('chooseTextFile reads the picked file and the renderer can import it directly', async ({
    plexo,
    dirs
  }) => {
    const filePath = join(dirs.userData, 'urls.txt')
    await writeFile(filePath, 'https://example.com/file1.zip\nhttps://example.com/file2.zip\n')
    await plexo.evaluateMain(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as never
    }, filePath)

    const content = await plexo.api.chooseTextFile()
    expect(content).toBe('https://example.com/file1.zip\nhttps://example.com/file2.zip\n')

    const queue = await plexo.api.createQueue('From file')
    const result = await plexo.api.addQueueDownloads(queue.id, (content ?? '').split('\n'))
    expect(result.added.map((item) => item.url)).toEqual([
      'https://example.com/file1.zip',
      'https://example.com/file2.zip'
    ])
  })

  test('chooseTextFile returns null when the dialog is cancelled', async ({ plexo }) => {
    await plexo.evaluateMain(({ dialog }) => {
      dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as never
    }, undefined)
    expect(await plexo.api.chooseTextFile()).toBeNull()
  })
})

test.describe('category rules CRUD @smoke', () => {
  test('create, update, and remove a rule', async ({ plexo }) => {
    const queue = await plexo.api.createQueue('Movies')
    const rule = await plexo.api.createCategoryRule({
      name: 'Movies by extension',
      matchType: 'extension',
      pattern: 'mp4,mkv,avi',
      targetQueueId: queue.id,
      enabled: true
    })
    expect(rule.name).toBe('Movies by extension')
    expect(rule.order).toBe(0)

    let rules = await plexo.api.getCategoryRules()
    expect(rules.map((r) => r.id)).toEqual([rule.id])

    const updated = await plexo.api.updateCategoryRule(rule.id, { enabled: false })
    expect(updated?.enabled).toBe(false)
    expect(await plexo.api.getCategoryRule(rule.id)).toMatchObject({ enabled: false })

    await plexo.api.removeCategoryRule(rule.id)
    rules = await plexo.api.getCategoryRules()
    expect(rules).toEqual([])
  })

  test('updating or removing an unknown rule is a no-op, not a crash', async ({ plexo }) => {
    expect(await plexo.api.updateCategoryRule('nope', { enabled: false })).toBeNull()
    await plexo.api.removeCategoryRule('nope')
    expect(await plexo.api.getCategoryRule('nope')).toBeNull()
  })

  test('reordering renumbers `order` and leaves out-of-band ids in place', async ({ plexo }) => {
    const queue = await plexo.api.createQueue('Target')
    const makeRule = (name: string): Promise<CategoryRule> =>
      plexo.api.createCategoryRule({
        name,
        matchType: 'urlPattern',
        pattern: name.toLowerCase(),
        targetQueueId: queue.id,
        enabled: true
      })
    const a = await makeRule('A')
    const b = await makeRule('B')
    const c = await makeRule('C')

    await plexo.api.reorderCategoryRules([c.id, a.id, b.id])
    let rules = await plexo.api.getCategoryRules()
    expect(rules.sort((x, y) => x.order - y.order).map((r) => r.id)).toEqual([c.id, a.id, b.id])

    // An id the caller forgot keeps its relative place instead of vanishing.
    await plexo.api.reorderCategoryRules([a.id])
    rules = await plexo.api.getCategoryRules()
    expect(rules.sort((x, y) => x.order - y.order).map((r) => r.id)).toEqual([a.id, c.id, b.id])
  })
})

// matchCategoryRule (src/shared/categoryRules.ts) is the one implementation of rule matching,
// imported directly by both CategoryRuleManager.matchRule (main) and IdleScreen (renderer) — no
// IPC round trip needed to classify a URL, and none needed to test it either. These don't touch
// the `plexo` fixture at all, so no Electron instance is launched for them.
test.describe('category rule matching', () => {
  test('an extension rule matches by file extension, case-insensitively', () => {
    const rule: CategoryRule = {
      id: 'r1',
      name: 'Movies',
      matchType: 'extension',
      pattern: 'mp4, MKV , avi',
      targetQueueId: 'queue-movies',
      enabled: true,
      order: 0
    }
    expect(matchCategoryRule('https://example.com/movie.MKV', [rule])).toBe('queue-movies')
    expect(matchCategoryRule('https://example.com/movie.mp4?x=1', [rule])).toBe('queue-movies')
    expect(matchCategoryRule('https://example.com/song.mp3', [rule])).toBeNull()
  })

  test('a urlPattern rule matches as a case-insensitive regex/substring', () => {
    const rule: CategoryRule = {
      id: 'r1',
      name: 'GitHub',
      matchType: 'urlPattern',
      pattern: 'github\\.com',
      targetQueueId: 'queue-gh',
      enabled: true,
      order: 0
    }
    expect(matchCategoryRule('https://GITHUB.com/x/y/releases/z.zip', [rule])).toBe('queue-gh')
    expect(matchCategoryRule('https://example.com/z.zip', [rule])).toBeNull()
  })

  test('first enabled match wins, in order', () => {
    const ruleA: CategoryRule = {
      id: 'a',
      name: 'A',
      matchType: 'extension',
      pattern: 'zip',
      targetQueueId: 'queue-a',
      enabled: true,
      order: 0
    }
    const ruleB: CategoryRule = {
      id: 'b',
      name: 'B',
      matchType: 'extension',
      pattern: 'zip',
      targetQueueId: 'queue-b',
      enabled: true,
      order: 1
    }
    expect(matchCategoryRule('https://example.com/x.zip', [ruleA, ruleB])).toBe('queue-a')
    // Order (the field), not array position, decides — passing them reversed changes nothing.
    expect(matchCategoryRule('https://example.com/x.zip', [ruleB, ruleA])).toBe('queue-a')
  })

  test('a disabled rule never matches, and a later enabled rule still gets its turn', () => {
    const disabled: CategoryRule = {
      id: 'a',
      name: 'Off',
      matchType: 'extension',
      pattern: 'zip',
      targetQueueId: 'queue-a',
      enabled: false,
      order: 0
    }
    const enabled: CategoryRule = {
      id: 'b',
      name: 'On',
      matchType: 'extension',
      pattern: 'zip',
      targetQueueId: 'queue-b',
      enabled: true,
      order: 1
    }
    expect(matchCategoryRule('https://example.com/x.zip', [disabled])).toBeNull()
    expect(matchCategoryRule('https://example.com/x.zip', [disabled, enabled])).toBe('queue-b')
  })

  test('no rule matching is a clean null, not a throw', () => {
    expect(matchCategoryRule('https://example.com/x.zip', [])).toBeNull()
  })

  test('an invalid regex pattern never matches (and never throws)', () => {
    const broken: CategoryRule = {
      id: 'a',
      name: 'Broken',
      matchType: 'urlPattern',
      pattern: '(unclosed',
      targetQueueId: 'queue-a',
      enabled: true,
      order: 0
    }
    expect(matchCategoryRule('https://example.com/x.zip', [broken])).toBeNull()
  })
})

test.describe('drag-and-drop reordering (UI) @smoke', () => {
  // Playwright's own `dragTo` simulates a mouse-based drag (pointer down/move/up); it does not
  // fire the dragstart/dragover/drop sequence an HTML5 `draggable` element relies on, so it never
  // triggers our onDragStart/onDropOnto handlers at all (verified by trying it first — `dragTo`
  // between two rows here leaves the list untouched). The real DragEvents, each carrying its own
  // DataTransfer (our handlers never read it back — they reorder from React state, the same
  // state the up/down buttons share — so the events don't need to share one), are what actually
  // drives it, dispatched by hand with a short pause after dragstart so React's state update
  // commits before the drop handler reads it (dispatchEvent is synchronous; without the pause,
  // onDrop would still see the pre-drag state in the same microtask).
  test('dragging a row to a new position reorders the list via reorderQueueItems', async ({
    plexo
  }) => {
    const queue = await plexo.api.createQueue('Drag me')
    const a = await plexo.api.addQueueDownload(queue.id, 'https://example.com/a.bin')
    const b = await plexo.api.addQueueDownload(queue.id, 'https://example.com/b.bin')
    const c = await plexo.api.addQueueDownload(queue.id, 'https://example.com/c.bin')

    const page = plexo.page
    await page.getByRole('button', { name: 'Queues' }).click()
    await page.getByRole('button', { name: /Drag me/ }).click()

    const rows = page.locator('[draggable="true"]')
    await expect(rows).toHaveCount(3)

    // Sanity check on the premise above: a mouse-based dragTo does nothing to this list.
    await rows.nth(2).dragTo(rows.nth(0))
    expect(
      (await plexo.api.getQueues()).find((q) => q.id === queue.id)?.items.map((i) => i.id)
    ).toEqual([a.id, b.id, c.id])

    await page.evaluate(() => {
      const draggable = Array.from(document.querySelectorAll('[draggable="true"]'))
      draggable[2].dispatchEvent(
        new DragEvent('dragstart', {
          bubbles: true,
          cancelable: true,
          dataTransfer: new DataTransfer()
        })
      )
    })
    await page.waitForTimeout(100) // let the dragstart's React state update commit

    await page.evaluate(() => {
      const draggable = Array.from(document.querySelectorAll('[draggable="true"]'))
      draggable[0].dispatchEvent(
        new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer: new DataTransfer()
        })
      )
      draggable[0].dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })
      )
    })

    await expect(async () => {
      const queues = await plexo.api.getQueues()
      const items = queues.find((q) => q.id === queue.id)?.items ?? []
      expect(items.map((item) => item.id)).toEqual([c.id, a.id, b.id])
    }).toPass({ timeout: 5_000 })
  })

  test('the up/down buttons still reorder — drag-and-drop is an addition, not a replacement', async ({
    plexo
  }) => {
    const queue = await plexo.api.createQueue('Buttons still work')
    const a = await plexo.api.addQueueDownload(queue.id, 'https://example.com/a.bin')
    const b = await plexo.api.addQueueDownload(queue.id, 'https://example.com/b.bin')

    const page = plexo.page
    await page.getByRole('button', { name: 'Queues' }).click()
    await page.getByRole('button', { name: /Buttons still work/ }).click()

    await page.getByRole('button', { name: 'Move down' }).first().click()

    await expect(async () => {
      const queues = await plexo.api.getQueues()
      const items = queues.find((q) => q.id === queue.id)?.items ?? []
      expect(items.map((item) => item.id)).toEqual([b.id, a.id])
    }).toPass({ timeout: 5_000 })
  })
})
